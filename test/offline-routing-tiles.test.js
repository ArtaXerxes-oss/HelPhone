// @vitest-environment node
/**
 * #893 — offline A* routing: HPGR tile build, time-based weights with a
 * scaled heuristic, versioned tiles with integrity checks, and an offline
 * route query through the real worker message handler.
 */
import { describe, expect, it } from "vitest";
import {
  aStar,
  buildGraphFromGeoJSON,
  createRng,
  dijkstra,
  generateRoadNetworkGeoJSON,
  isClosed,
  nearestNode,
  packGraph,
  roadSpeedMps,
  unpackGraph,
} from "../src/utils/graphTraversal.js";
import { createRoutingState, handleRoutingMessage } from "../src/workers/routingWorker.js";
import { buildRoutingTile, canonicalizeRoadGeoJSON, verifyRoutingTile } from "../src/lib/routingTiles.js";
import { BundleIntegrityError, canonicalJson, sha256Hex } from "../src/lib/offlineBundle.js";
import { createOfflineRouter } from "../src/lib/offlineRouting.js";

const KMH = 1 / 3.6;

/** A grid with a mix of road classes, speed limits, closures and shelters. */
function zoneGeoJSON({ rows = 24, cols = 24, seed = 7 } = {}) {
  const base = generateRoadNetworkGeoJSON({ rows, cols, shapePoints: 1, seed });
  const rand = createRng(seed + 1);
  const classes = ["primary", "secondary", "residential", "residential", "service"];
  for (const f of base.features) {
    f.properties.highway = classes[Math.floor(rand() * classes.length)];
    const r = rand();
    if (r < 0.15) f.properties.maxspeed = "60";
    else if (r < 0.2) f.properties.maxspeed = "20 mph";
    else if (r < 0.23) f.properties.closed = "yes";
    f.properties.osm_id = Math.floor(rand() * 1e9); // irrelevant to routing
  }
  const [lng0, lat0] = base.features[0].geometry.coordinates[0];
  base.features.push(
    { type: "Feature", properties: { amenity: "shelter", name: "Stadium shelter" }, geometry: { type: "Point", coordinates: [lng0 + 0.01, lat0 + 0.01] } },
    { type: "Feature", properties: { amenity: "hospital", name: "General hospital" }, geometry: { type: "Point", coordinates: [lng0 + 0.02, lat0 + 0.005] } },
    { type: "Feature", properties: { amenity: "cafe", name: "Not a destination" }, geometry: { type: "Point", coordinates: [lng0, lat0] } },
  );
  return base;
}

function shuffled(geojson, seed) {
  const rand = createRng(seed);
  const features = geojson.features.map((f) => ({
    ...f,
    // Same tags, different key order: must not change the tile.
    properties: Object.fromEntries(Object.entries(f.properties).reverse()),
  }));
  for (let i = features.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [features[i], features[j]] = [features[j], features[i]];
  }
  return { ...geojson, features };
}

describe("road speeds and closures", () => {
  it.each([
    [{ maxspeed: "50" }, 50],
    [{ maxspeed: "30 mph" }, 30 * 1.609344],
    [{ maxspeed: "50;30" }, 30],
    [{ maxspeed: 40 }, 40],
    [{ highway: "primary" }, 50],
    [{ highway: "residential", maxspeed: "signals" }, 25],
    [{ highway: "no-such-class" }, 25],
  ])("%j → %d km/h", (props, kmh) => {
    expect(roadSpeedMps(props)).toBeCloseTo(kmh * KMH, 9);
  });

  it("treats maxspeed=0 as impassable", () => {
    expect(roadSpeedMps({ maxspeed: "0" })).toBe(0);
  });

  it.each([
    [{ closed: "yes" }, true],
    [{ access: "no" }, true],
    [{ access: "private" }, true],
    [{ highway: "construction" }, true],
    [{ highway: "primary", access: "yes" }, false],
    [null, false],
  ])("isClosed(%j) = %s", (props, closed) => {
    expect(isClosed(props)).toBe(closed);
  });

  it("leaves closed roads out of the graph", () => {
    const road = (closed) => ({
      type: "Feature",
      properties: { highway: "primary", ...(closed ? { closed: "yes" } : {}) },
      geometry: { type: "LineString", coordinates: closed ? [[0, 0], [0.01, 0]] : [[0, 0], [0, 0.01]] },
    });
    const g = buildGraphFromGeoJSON({ type: "FeatureCollection", features: [road(false), road(true)] }, { weighting: "time" });
    expect(g.nodeCount).toBe(2);
    expect(g.edgeCount).toBe(2);
  });
});

describe("time-based weights with a scaled heuristic", () => {
  const geojson = zoneGeoJSON();
  const timeGraph = buildGraphFromGeoJSON(geojson, { weighting: "time" });

  it("weights edges in seconds and records the fastest speed", () => {
    expect(timeGraph.weighting).toBe("time");
    expect(timeGraph.maxSpeedMps).toBeCloseTo(60 * KMH, 9);
    // A 50 km/h primary road segment of L metres costs L / 13.9 s.
    const one = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { highway: "primary" }, geometry: { type: "LineString", coordinates: [[3.38, 6.52], [3.39, 6.52]] } }],
    };
    const distance = buildGraphFromGeoJSON(one, { weighting: "distance" });
    const time = buildGraphFromGeoJSON(one, { weighting: "time" });
    expect(time.weights[0]).toBeCloseTo(distance.weights[0] / (50 * KMH), 6);
  });

  it("keeps A* exact: same travel time as Dijkstra on 300 random pairs", () => {
    const rand = createRng(99);
    let expandedA = 0;
    let expandedD = 0;
    for (let i = 0; i < 300; i++) {
      const s = Math.floor(rand() * timeGraph.nodeCount);
      const t = Math.floor(rand() * timeGraph.nodeCount);
      const a = aStar(timeGraph, s, t);
      const d = dijkstra(timeGraph, s, t);
      if (Number.isFinite(d.distance)) expect(a.distance).toBeCloseTo(d.distance, 6);
      else expect(a.distance).toBe(Infinity);
      expandedA += a.expanded;
      expandedD += d.expanded;
    }
    // The heuristic still prunes the search.
    expect(expandedA).toBeLessThan(expandedD);
  });
});

describe("HPGR header", () => {
  it("round-trips weighting and max speed", () => {
    const g = buildGraphFromGeoJSON(zoneGeoJSON({ rows: 6, cols: 6 }), { weighting: "time" });
    const view = unpackGraph(packGraph(g));
    expect(view.weighting).toBe("time");
    expect(view.maxSpeedMps).toBe(g.maxSpeedMps);
    expect(Array.from(view.weights)).toEqual(Array.from(g.weights));
  });

  it("reads a pre-#893 buffer (reserved header words zero) as distance-weighted", () => {
    const g = buildGraphFromGeoJSON(zoneGeoJSON({ rows: 6, cols: 6 }));
    const buffer = packGraph(g);
    new Uint32Array(buffer, 16, 4).fill(0);
    expect(unpackGraph(buffer).weighting).toBe("distance");
  });

  it("rejects an unknown weighting code and a truncated buffer", () => {
    const buffer = packGraph(buildGraphFromGeoJSON(zoneGeoJSON({ rows: 6, cols: 6 })));
    const bad = buffer.slice(0);
    new Uint32Array(bad, 16, 1)[0] = 7;
    expect(() => unpackGraph(bad)).toThrow(/weighting code/);
    expect(() => unpackGraph(buffer.slice(0, buffer.byteLength - 8))).toThrow(/Truncated/);
  });
});

describe("tile build", () => {
  const geojson = zoneGeoJSON();

  it("is reproducible: feature order, tag key order and unrelated tags do not change a byte", async () => {
    const a = await buildRoutingTile(geojson, { zone: "test-zone", version: 1 });
    for (const seed of [1, 2, 3]) {
      const b = await buildRoutingTile(shuffled(geojson, seed), { zone: "test-zone", version: 1 });
      expect(await sha256Hex(b.tile)).toBe(await sha256Hex(a.tile));
      expect(canonicalJson(b.manifest)).toBe(canonicalJson(a.manifest));
    }
  });

  it("keeps routing tags and named destinations only", () => {
    const { roads, destinations } = canonicalizeRoadGeoJSON(geojson);
    for (const f of roads.features) expect(Object.keys(f.properties).every((k) => ["highway", "maxspeed", "oneway", "access", "closed"].includes(k))).toBe(true);
    expect(destinations.map((d) => [d.kind, d.name])).toEqual([
      ["hospital", "General hospital"],
      ["shelter", "Stadium shelter"],
    ]);
  });

  it("describes the tile in a versioned manifest that verifies it", async () => {
    const { manifest, tile } = await buildRoutingTile(geojson, { zone: "test-zone", version: 3 });
    expect(manifest).toMatchObject({ format: "helphone-offline-bundle/1", kind: "routing", zone: "test-zone", version: 3 });
    expect(manifest.files[0].path).toBe("test-zone.v3.hpgr");
    const { graph } = await verifyRoutingTile(tile, manifest);
    expect(graph.nodeCount).toBe(manifest.files[0].nodeCount);
  });

  it("rejects a tampered, truncated or relabelled tile", async () => {
    const { manifest, tile } = await buildRoutingTile(geojson, { zone: "test-zone", version: 1 });
    const flipped = tile.slice();
    flipped[flipped.length - 3] ^= 0x01;
    await expect(verifyRoutingTile(flipped, manifest)).rejects.toMatchObject({ reason: "hash-mismatch" });
    await expect(verifyRoutingTile(tile.slice(0, -8), manifest)).rejects.toMatchObject({ reason: "size-mismatch" });
    const lie = structuredClone(manifest);
    lie.files[0].nodeCount += 1;
    await expect(verifyRoutingTile(tile, lie)).rejects.toBeInstanceOf(BundleIntegrityError);
  });
});

describe("graph footprint", () => {
  it("packs to the ADR-006 budget: ~7.5 MB for the spike's 100,485-node / 349,977-edge network", () => {
    // Exact packed size from the layout (header + 4 Float64 coords per node,
    // Float64 weight + Uint32 target per edge, Uint32 offsets).
    const n = 100_485;
    const m = 349_977;
    const small = buildGraphFromGeoJSON(zoneGeoJSON({ rows: 10, cols: 10 }), { weighting: "time" });
    const perNodeEdge = (g) => 32 + g.nodeCount * 32 + (g.nodeCount + 1) * 4 + g.edgeCount * 12;
    const packed = packGraph(small).byteLength;
    expect(packed - perNodeEdge(small)).toBeGreaterThanOrEqual(0);
    expect(packed - perNodeEdge(small)).toBeLessThan(16); // alignment padding only
    const full = 32 + n * 32 + (n + 1) * 4 + m * 12;
    expect(full / 2 ** 20).toBeLessThan(7.6); // MiB; time weighting adds no bytes per element
  });
});

// ── Offline end-to-end: no network, tiles from the cache ────────────────────

/** Minimal CacheStorage over a Map, matching what the router uses. */
function memoryCaches() {
  const stores = new Map();
  return {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      const key = (r) => (typeof r === "string" ? r : r.url);
      return {
        async match(r) {
          const hit = m.get(key(r));
          return hit ? hit.clone() : undefined;
        },
        async put(r, res) {
          m.set(key(r), res.clone());
        },
        async delete(r) {
          return m.delete(key(r));
        },
      };
    },
  };
}

/** A Worker stand-in that runs the real routing handler in-process. */
function inProcessWorker() {
  const state = createRoutingState();
  const w = {
    onmessage: null,
    postMessage(msg) {
      const { reply } = handleRoutingMessage(state, structuredClone(msg));
      queueMicrotask(() => w.onmessage && w.onmessage({ data: reply }));
    },
    terminate() {},
  };
  return w;
}

function servedFiles(files) {
  const calls = [];
  let online = true;
  const fetchImpl = async (url) => {
    calls.push(url);
    if (!online) throw new TypeError("Failed to fetch (offline)");
    const body = files.get(url);
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200 });
  };
  return { fetchImpl, calls, goOffline: () => (online = false) };
}

describe("offline route query (E2E through the worker protocol)", () => {
  async function published(version, mutate) {
    const built = await buildRoutingTile(zoneGeoJSON(), { zone: "test-zone", version });
    const tile = mutate ? mutate(built.tile.slice()) : built.tile;
    return {
      built,
      files: [
        [`/routing-tiles/test-zone.manifest.json`, canonicalJson(built.manifest)],
        [`/routing-tiles/${built.manifest.files[0].path}`, tile],
      ],
    };
  }

  it("routes with the network gone, from the verified cached tile", async () => {
    const v1 = await published(1);
    const server = servedFiles(new Map(v1.files));
    const cacheStorage = memoryCaches();
    const events = [];
    const options = { fetchImpl: server.fetchImpl, cacheStorage, createWorker: inProcessWorker, onEvent: (e) => events.push(e) };

    // First visit, online: downloads and caches.
    const first = createOfflineRouter(options);
    expect((await first.loadZone("test-zone")).tileSource).toBe("network");
    first.dispose();

    // Later, a cold start with no network at all.
    server.goOffline();
    const router = createOfflineRouter(options);
    const loaded = await router.loadZone("test-zone");
    expect(loaded).toMatchObject({ zone: "test-zone", version: 1, tileSource: "cache", manifestSource: "cache", weighting: "time" });

    const g = v1.built.graph;
    const from = [g.lat[0], g.lng[0]];
    const to = [g.lat[g.nodeCount - 1], g.lng[g.nodeCount - 1]];
    const route = await router.route(from, to);
    expect(route.reachable).toBe(true);
    expect(route.durationS).toBeGreaterThan(0);
    expect(route.coordinates.length).toBeGreaterThanOrEqual(4);
    expect(route.snapped).toMatchObject({ from: 0, to: g.nodeCount - 1 });
    // The answer matches a direct A* on the same graph.
    expect(route.cost).toBeCloseTo(aStar(g, 0, g.nodeCount - 1).distance, 6);
    expect(nearestNode(g, from[0] + 1e-6, from[1])).toBe(0);
  });

  it("keeps the last verified tile when a newer release fails verification", async () => {
    const v1 = await published(1);
    const v2bad = await published(2, (tile) => {
      tile[tile.length - 1] ^= 0xff;
      return tile;
    });
    const files = new Map(v1.files);
    const server = servedFiles(files);
    const cacheStorage = memoryCaches();
    const events = [];
    const options = { fetchImpl: server.fetchImpl, cacheStorage, createWorker: inProcessWorker, onEvent: (e) => events.push(e) };

    const router = createOfflineRouter(options);
    await router.loadZone("test-zone");

    for (const [k, v] of v2bad.files) files.set(k, v);
    const refreshed = await router.loadZone("test-zone");
    expect(refreshed).toMatchObject({ version: 1, stale: true });
    expect(events.some((e) => e.type === "tile-rejected" && e.version === 2 && e.reason === "hash-mismatch")).toBe(true);

    // A cold start also falls back to the last verified release, not the bad one.
    const cold = createOfflineRouter(options);
    expect(await cold.loadZone("test-zone")).toMatchObject({ version: 1, stale: true });
    const g = v1.built.graph;
    expect((await cold.route([g.lat[0], g.lng[0]], [g.lat[5], g.lng[5]])).reachable).toBe(true);
  });

  it("refuses to route when no tile ever verified", async () => {
    const bad = await published(1, (tile) => {
      tile[40] ^= 0x10;
      return tile;
    });
    const server = servedFiles(new Map(bad.files));
    const router = createOfflineRouter({ fetchImpl: server.fetchImpl, cacheStorage: memoryCaches(), createWorker: inProcessWorker });
    await expect(router.loadZone("test-zone")).rejects.toMatchObject({ reason: "hash-mismatch" });
    await expect(router.route([0, 0], [0, 0])).rejects.toThrow(/No offline routing zone/);
  });
});
