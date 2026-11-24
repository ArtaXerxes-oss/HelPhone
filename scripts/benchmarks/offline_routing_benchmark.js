#!/usr/bin/env node
/**
 * #893 offline routing benchmark: HPGR tile build + time-weighted A* through
 * the routing worker, on the same 317×317 synthetic network as spike #606.
 *
 *   node --expose-gc scripts/benchmarks/offline_routing_benchmark.js \
 *        [--rows 317] [--queries 200] [--out docs/spikes/results/offline-routing-893.json]
 *
 * Measures: tile build time and size, build reproducibility (two builds,
 * shuffled input, same SHA-256), and route latency for 200 random pairs with
 * the real worker message handler (in a worker_threads Worker, as in the app).
 */

import os from "node:os";
import { writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { createRng, generateRoadNetworkGeoJSON } from "../../src/utils/graphTraversal.js";
import { buildRoutingTile } from "../../src/lib/routingTiles.js";
import { sha256Hex } from "../../src/lib/offlineBundle.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

function stats(samples) {
  const s = Float64Array.from(samples).sort();
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  const r = (v) => +v.toFixed(3);
  return { n: s.length, mean: r(mean), p50: r(q(0.5)), p95: r(q(0.95)), max: r(s[s.length - 1]) };
}

/** The spike network with realistic tags: road classes, speed limits, closures. */
function taggedNetwork(rows, seed = 7) {
  const base = generateRoadNetworkGeoJSON({ rows, cols: rows });
  const rand = createRng(seed);
  const classes = ["primary", "secondary", "tertiary", "residential", "residential", "residential", "service"];
  for (const f of base.features) {
    f.properties.highway = classes[Math.floor(rand() * classes.length)];
    const r = rand();
    if (r < 0.15) f.properties.maxspeed = "60";
    else if (r < 0.2) f.properties.maxspeed = "20 mph";
    else if (r < 0.22) f.properties.closed = "yes";
  }
  return base;
}

function shuffle(geojson, seed) {
  const rand = createRng(seed);
  const features = geojson.features.slice();
  for (let i = features.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [features[i], features[j]] = [features[j], features[i]];
  }
  return { ...geojson, features };
}

const workerSource = `
  import { parentPort } from "node:worker_threads";
  import { createRoutingState, handleRoutingMessage } from ${JSON.stringify(new URL("../../src/workers/routingWorker.js", import.meta.url).href)};
  const state = createRoutingState();
  parentPort.on("message", (msg) => {
    const { reply, transfer } = handleRoutingMessage(state, msg);
    parentPort.postMessage(reply, transfer);
  });
`;

function rpc(worker, msg, transfer = []) {
  return new Promise((resolve, reject) => {
    const on = (reply) => {
      if (reply.id !== msg.id) return;
      worker.off("message", on);
      reply.type === "error" ? reject(new Error(reply.message)) : resolve(reply);
    };
    worker.on("message", on);
    worker.postMessage(msg, transfer);
  });
}

const rows = Number(arg("rows", 317));
const queries = Number(arg("queries", 200));
const weighting = arg("weighting", "time");
const out = arg("out", null);
const log = (...a) => console.log("[offline-routing]", ...a);

const geojson = taggedNetwork(rows);
log(`network: ${geojson.features.length} road features`);

let t = performance.now();
const a = await buildRoutingTile(geojson, { zone: "bench-zone", version: 1, weighting });
const buildMs = performance.now() - t;
t = performance.now();
const b = await buildRoutingTile(shuffle(geojson, 11), { zone: "bench-zone", version: 1, weighting });
const rebuildMs = performance.now() - t;
const shaA = await sha256Hex(a.tile);
const shaB = await sha256Hex(b.tile);
log(`tile: ${a.graph.nodeCount} nodes, ${a.graph.edgeCount} edges, ${(a.tile.byteLength / 2 ** 20).toFixed(2)} MiB, built in ${buildMs.toFixed(0)} ms`);
log(`reproducible: ${shaA === shaB} (${shaA.slice(0, 16)}…)`);

const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(workerSource)}`));
const buffer = a.tile.slice().buffer;
await rpc(worker, { id: 0, type: "load", graph: buffer }, [buffer]);

const g = a.graph;
const rand = createRng(1234);
const latencies = [];
const roundTrips = [];
let reachable = 0;
let expanded = 0;
for (let i = 1; i <= queries; i++) {
  const s = Math.floor(rand() * g.nodeCount);
  const d = Math.floor(rand() * g.nodeCount);
  const t0 = performance.now();
  const r = await rpc(worker, { id: i, type: "routeLatLng", from: [g.lat[s], g.lng[s]], to: [g.lat[d], g.lng[d]] });
  roundTrips.push(performance.now() - t0);
  latencies.push(r.elapsedMs);
  expanded += r.expanded;
  if (Number.isFinite(r.distance)) reachable++;
}
await worker.terminate();

const result = {
  issue: "#893",
  generatedAt: new Date().toISOString(),
  environment: { node: process.version, cpu: os.cpus()[0]?.model, cores: os.cpus().length },
  network: { rows, cols: rows, features: geojson.features.length, nodeCount: g.nodeCount, edgeCount: g.edgeCount },
  tile: {
    weighting: g.weighting,
    maxSpeedKmh: +(g.maxSpeedMps * 3.6).toFixed(1),
    bytes: a.tile.byteLength,
    mib: +(a.tile.byteLength / 2 ** 20).toFixed(2),
    buildMs: Math.round(buildMs),
    rebuildShuffledMs: Math.round(rebuildMs),
    sha256: shaA,
    reproducible: shaA === shaB,
  },
  queries: {
    count: queries,
    reachable,
    meanExpanded: Math.round(expanded / queries),
    workerQueryMs: stats(latencies),
    roundTripMs: stats(roundTrips),
  },
};
console.log(JSON.stringify(result, null, 2));
if (typeof out === "string") await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
