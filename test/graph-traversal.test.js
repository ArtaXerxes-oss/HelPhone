// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  IndexedMinHeap,
  aStar,
  buildContractionHierarchy,
  buildGraphFromGeoJSON,
  chShortestPath,
  createChQueryContext,
  createRng,
  createSearchContext,
  dijkstra,
  generateRoadNetworkGeoJSON,
  haversineMeters,
  packContractionHierarchy,
  packGraph,
  unpackContractionHierarchy,
  unpackGraph,
} from "../src/utils/graphTraversal.js";
import {
  createRoutingState,
  handleRoutingMessage,
} from "../src/workers/routingWorker.js";

// ---------------------------------------------------------------------------
// Offline routing spike (#606): CSR graph building, Dijkstra / A* /
// Contraction Hierarchies agreement, zero-copy packing and the worker
// message protocol.
// ---------------------------------------------------------------------------

const line = (coords, props = {}) => ({
  type: "Feature",
  properties: props,
  geometry: { type: "LineString", coordinates: coords },
});

function pathLength(graph, path) {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    let best = Infinity;
    for (let e = graph.offsets[path[i - 1]]; e < graph.offsets[path[i - 1] + 1]; e++)
      if (graph.targets[e] === path[i]) best = Math.min(best, graph.weights[e]);
    if (best === Infinity) throw new Error(`no edge ${path[i - 1]}->${path[i]}`);
    total += best;
  }
  return total;
}

describe("buildGraphFromGeoJSON", () => {
  it("creates nodes only at endpoints and shared coordinates", () => {
    const graph = buildGraphFromGeoJSON({
      type: "FeatureCollection",
      features: [
        line([[0, 0], [0.0005, 0], [0.001, 0]]), // shape point in the middle
        line([[0.001, 0], [0.001, 0.001]]),
      ],
    });
    expect(graph.nodeCount).toBe(3);
    expect(graph.edgeCount).toBe(4); // two undirected segments
  });

  it("splits a line where another line crosses an interior vertex", () => {
    const graph = buildGraphFromGeoJSON({
      type: "FeatureCollection",
      features: [
        line([[0, 0], [0.001, 0], [0.002, 0]]),
        line([[0.001, -0.001], [0.001, 0], [0.001, 0.001]]),
      ],
    });
    expect(graph.nodeCount).toBe(5);
  });

  it("respects oneway and accumulates polyline length", () => {
    const graph = buildGraphFromGeoJSON({
      type: "FeatureCollection",
      features: [line([[0, 0], [0.0005, 0.0005], [0.001, 0]], { oneway: "yes" })],
    });
    expect(graph.edgeCount).toBe(1);
    const direct = haversineMeters(0, 0, 0, 0.001);
    expect(graph.weights[0]).toBeGreaterThan(direct * 1.3); // detour via shape point
    const back = dijkstra(graph, 1, 0);
    expect(back.distance).toBe(Infinity);
    expect(back.path).toBeNull();
  });

  it("handles MultiLineString and ignores features without geometry", () => {
    const graph = buildGraphFromGeoJSON({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: null },
        {
          type: "Feature",
          properties: {},
          geometry: { type: "MultiLineString", coordinates: [[[0, 0], [0.001, 0]], [[0.001, 0], [0.002, 0]]] },
        },
      ],
    });
    expect(graph.nodeCount).toBe(3);
  });
});

describe("IndexedMinHeap", () => {
  it("pops in key order with decrease- and increase-key", () => {
    const heap = new IndexedMinHeap(10);
    [5, 3, 8, 1, 9].forEach((k, node) => heap.set(node, k));
    heap.set(2, 0); // decrease
    heap.set(3, 10); // increase
    const order = [];
    while (heap.size) order.push(heap.pop());
    expect(order).toEqual([2, 1, 0, 4, 3]);
  });
});

describe("shortest path algorithms agree", () => {
  const cases = [
    { rows: 12, cols: 12, seed: 1, onewayRate: 0.3, dropRate: 0.15 },
    { rows: 20, cols: 15, seed: 7, onewayRate: 0.1, dropRate: 0.05 },
  ];
  for (const opts of cases) {
    it(`on a ${opts.rows}x${opts.cols} network (seed ${opts.seed})`, () => {
      const graph = unpackGraph(packGraph(buildGraphFromGeoJSON(generateRoadNetworkGeoJSON(opts))));
      const ch = unpackContractionHierarchy(packContractionHierarchy(buildContractionHierarchy(graph)));
      const ctx = createSearchContext(graph.nodeCount);
      const chCtx = createChQueryContext(graph.nodeCount);
      const rand = createRng(opts.seed);
      let reachable = 0;
      for (let q = 0; q < 150; q++) {
        const s = Math.floor(rand() * graph.nodeCount);
        const t = Math.floor(rand() * graph.nodeCount);
        const d = dijkstra(graph, s, t, { context: ctx });
        const a = aStar(graph, s, t, { context: ctx });
        const c = chShortestPath(ch, s, t, { context: chCtx });
        if (d.distance === Infinity) {
          expect(a.distance).toBe(Infinity);
          expect(c.distance).toBe(Infinity);
          continue;
        }
        reachable++;
        for (const r of [a, c]) {
          expect(r.distance).toBeCloseTo(d.distance, 6);
          expect(r.path[0]).toBe(s);
          expect(r.path[r.path.length - 1]).toBe(t);
          expect(pathLength(graph, r.path)).toBeCloseTo(d.distance, 6);
        }
        expect(a.expanded).toBeLessThanOrEqual(d.expanded);
      }
      expect(reachable).toBeGreaterThan(50);
    });
  }

  it("returns a zero-length path from a node to itself", () => {
    const graph = buildGraphFromGeoJSON(generateRoadNetworkGeoJSON({ rows: 3, cols: 3, dropRate: 0 }));
    const r = aStar(graph, 4, 4);
    expect(r.distance).toBe(0);
    expect(Array.from(r.path)).toEqual([4]);
    const ch = buildContractionHierarchy(graph);
    expect(chShortestPath(ch, 4, 4).distance).toBe(0);
  });

  it("rejects out-of-range nodes", () => {
    const graph = buildGraphFromGeoJSON(generateRoadNetworkGeoJSON({ rows: 3, cols: 3 }));
    expect(() => dijkstra(graph, -1, 0)).toThrow(RangeError);
    expect(() => aStar(graph, 0, graph.nodeCount)).toThrow(RangeError);
  });
});

describe("packed buffers", () => {
  it("round-trips a graph through a SharedArrayBuffer without copying", () => {
    const graph = buildGraphFromGeoJSON(generateRoadNetworkGeoJSON({ rows: 5, cols: 5 }));
    const buffer = packGraph(graph, { shared: true });
    expect(buffer).toBeInstanceOf(SharedArrayBuffer);
    const view = unpackGraph(buffer);
    expect(view.targets.buffer).toBe(buffer);
    expect(Array.from(view.offsets)).toEqual(Array.from(graph.offsets));
    expect(Array.from(view.weights)).toEqual(Array.from(graph.weights));
  });

  it("rejects buffers of the wrong kind", () => {
    const graph = buildGraphFromGeoJSON(generateRoadNetworkGeoJSON({ rows: 3, cols: 3 }));
    expect(() => unpackContractionHierarchy(packGraph(graph))).toThrow(/contraction hierarchy/);
    expect(() => unpackGraph(new ArrayBuffer(64))).toThrow(/routing graph/);
  });
});

describe("routingWorker message handler", () => {
  const geojson = generateRoadNetworkGeoJSON({ rows: 8, cols: 8, seed: 3, onewayRate: 0, dropRate: 0 });

  it("loads GeoJSON, builds a CH and routes with every algorithm", () => {
    const state = createRoutingState();
    const loaded = handleRoutingMessage(state, { id: 1, type: "loadGeoJSON", geojson: JSON.stringify(geojson) }).reply;
    expect(loaded.type).toBe("loadGeoJSON:ok");
    expect(loaded.nodeCount).toBeGreaterThan(50);

    const built = handleRoutingMessage(state, { id: 2, type: "buildCH" });
    expect(built.reply.type).toBe("buildCH:ok");
    expect(built.transfer).toHaveLength(1);

    const to = loaded.nodeCount - 1;
    const results = ["dijkstra", "astar", "ch"].map(
      (algorithm) => handleRoutingMessage(state, { id: 3, type: "route", from: 0, to, algorithm }).reply,
    );
    for (const r of results) {
      expect(r.type).toBe("route:ok");
      expect(r.distance).toBeCloseTo(results[0].distance, 6);
      expect(r.coordinates.length).toBe(r.path.length * 2);
    }
  });

  it("accepts a packed graph + CH and reports errors without throwing", () => {
    const graph = buildGraphFromGeoJSON(geojson);
    const state = createRoutingState();
    expect(handleRoutingMessage(state, { id: 1, type: "route", from: 0, to: 1 }).reply).toMatchObject({
      type: "error",
      message: "Routing graph not loaded",
    });
    const ch = packContractionHierarchy(buildContractionHierarchy(graph));
    const r = handleRoutingMessage(state, { id: 2, type: "load", graph: packGraph(graph), ch }).reply;
    expect(r).toMatchObject({ type: "load:ok", hasCH: true });
    expect(handleRoutingMessage(state, { id: 3, type: "route", from: 0, to: 99999 }).reply.type).toBe("error");
    expect(handleRoutingMessage(state, { id: 4, type: "nope" }).reply.message).toMatch(/Unknown/);
    expect(handleRoutingMessage(state, { id: 5, type: "ping" }).reply.type).toBe("ping:ok");
  });

  it("refuses CH routing before a hierarchy exists", () => {
    const state = createRoutingState();
    handleRoutingMessage(state, { type: "load", graph: packGraph(buildGraphFromGeoJSON(geojson)) });
    expect(handleRoutingMessage(state, { type: "route", from: 0, to: 1, algorithm: "ch" }).reply.message).toMatch(
      /not built/,
    );
  });
});
