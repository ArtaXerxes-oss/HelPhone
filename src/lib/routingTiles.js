/**
 * OSM/GeoJSON → HPGR routing tiles (#893, ADR-006 follow-up).
 *
 * A routing tile is one packed CSR graph (`packGraph`, "HPGR" header) for an
 * incident zone, shipped as a single-file offline bundle (offlineBundle.js)
 * so the client can version it and verify it before loading.
 *
 * Input is a GeoJSON FeatureCollection of road LineStrings carrying OSM tags
 * as properties (`highway`, `maxspeed`, `oneway`, `access`, plus HelPhone's
 * `closed` for incident closures), e.g. the output of
 *   osmium tags-filter extract.osm.pbf w/highway -o roads.osm.pbf
 *   osmium export roads.osm.pbf -o roads.geojson
 * Point features tagged as shelters, hospitals or assembly points become the
 * tile's named destinations.
 *
 * Reproducibility: the input is reduced to the fields routing uses and
 * sorted before the graph is built, so feature order, unrelated tags (names,
 * OSM ids, timestamps) and the extract tool's key order do not change a
 * single byte of the tile.
 */

import { buildGraphFromGeoJSON, packGraph, unpackGraph } from "../utils/graphTraversal.js";
import {
  BundleIntegrityError,
  bundleFile,
  createBundleManifest,
  validateBundleManifest,
  verifyBundleFile,
} from "./offlineBundle.js";

export const ROUTING_TAGS = Object.freeze(["highway", "maxspeed", "oneway", "access", "closed"]);

/** OSM tags that make a Point a routing destination, and the kind they map to. */
const DESTINATION_KINDS = Object.freeze({
  shelter: "shelter",
  hospital: "hospital",
  clinic: "hospital",
  fire_station: "fire-station",
  police: "police",
  assembly_point: "assembly-point",
});

const COORD_DECIMALS = 7;
const round = (v) => Number(v.toFixed(COORD_DECIMALS));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function destinationKind(props) {
  if (!props) return null;
  return (
    DESTINATION_KINDS[props.amenity] ||
    DESTINATION_KINDS[props.emergency] ||
    (props.highway === "emergency_access_point" ? "assembly-point" : null)
  );
}

/**
 * Reduces road GeoJSON to what routing reads, in a canonical order.
 * Returns { roads: FeatureCollection, destinations: [...] }.
 */
export function canonicalizeRoadGeoJSON(geojson) {
  const roads = [];
  const destinations = [];
  for (const f of (geojson && geojson.features) || []) {
    const g = f && f.geometry;
    if (!g) continue;
    const props = f.properties || {};
    if (g.type === "Point") {
      const kind = destinationKind(props);
      const [lng, lat] = g.coordinates || [];
      if (kind && Number.isFinite(lat) && Number.isFinite(lng))
        destinations.push({
          name: typeof props.name === "string" && props.name.trim() ? props.name.trim().slice(0, 80) : kind,
          kind,
          lat: round(lat),
          lng: round(lng),
        });
      continue;
    }
    if (typeof props.highway !== "string") continue;
    const parts = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    const kept = {};
    for (const k of ROUTING_TAGS) if (props[k] !== undefined && props[k] !== null) kept[k] = String(props[k]);
    for (const coords of parts) {
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const line = coords.map(([lng, lat]) => [round(lng), round(lat)]);
      roads.push({ type: "Feature", properties: kept, geometry: { type: "LineString", coordinates: line } });
    }
  }
  const keyed = roads.map((r) => [JSON.stringify([r.geometry.coordinates, r.properties]), r]);
  keyed.sort((a, b) => cmp(a[0], b[0]));
  destinations.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.name, b.name) || a.lat - b.lat || a.lng - b.lng);
  return { roads: { type: "FeatureCollection", features: keyed.map((k) => k[1]) }, destinations };
}

function bboxOf(graph) {
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (let v = 0; v < graph.nodeCount; v++) {
    const la = graph.lat[v];
    const ln = graph.lng[v];
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
    if (ln < minLng) minLng = ln;
    if (ln > maxLng) maxLng = ln;
  }
  return graph.nodeCount ? [round(minLng), round(minLat), round(maxLng), round(maxLat)] : null;
}

export const routingTilePath = (zone, version) => `${zone}.v${version}.hpgr`;

/**
 * Builds a routing tile bundle.
 * @returns {Promise<{ manifest: object, tile: Uint8Array, graph: object }>}
 */
export async function buildRoutingTile(geojson, { zone, version, weighting = "time" }) {
  const { roads, destinations } = canonicalizeRoadGeoJSON(geojson);
  const graph = buildGraphFromGeoJSON(roads, { weighting });
  if (graph.nodeCount === 0) throw new Error("No routable roads in the input");
  const tile = new Uint8Array(packGraph(graph));
  const path = routingTilePath(zone, version);
  const manifest = await createBundleManifest({
    kind: "routing",
    zone,
    version,
    files: [
      {
        path,
        bytes: tile,
        meta: {
          nodeCount: graph.nodeCount,
          edgeCount: graph.edgeCount,
          weighting: graph.weighting,
          maxSpeedMps: graph.maxSpeedMps,
        },
      },
    ],
    extra: { bbox: bboxOf(graph), destinations },
  });
  return { manifest, tile, graph };
}

/** The single HPGR entry of a routing manifest. */
export function routingTileEntry(manifest) {
  validateBundleManifest(manifest, { kind: "routing" });
  const entry = manifest.files.find((f) => f.path.endsWith(".hpgr"));
  if (!entry) throw new BundleIntegrityError("malformed-manifest", "Routing manifest has no .hpgr file");
  return entry;
}

/**
 * Verifies a downloaded tile against its manifest entry (size, SHA-256, and
 * that the HPGR header agrees with the manifest) and returns the graph view.
 */
export async function verifyRoutingTile(data, manifest) {
  const entry = routingTileEntry(manifest);
  const bytes = await verifyBundleFile(data, entry);
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  let graph;
  try {
    graph = unpackGraph(buffer);
  } catch (err) {
    throw new BundleIntegrityError("bad-tile", `${entry.path}: ${err.message}`);
  }
  if (
    graph.nodeCount !== entry.nodeCount ||
    graph.edgeCount !== entry.edgeCount ||
    graph.weighting !== entry.weighting
  )
    throw new BundleIntegrityError("header-mismatch", `${entry.path}: HPGR header disagrees with the manifest`);
  return { graph, buffer, entry };
}

export { bundleFile };
