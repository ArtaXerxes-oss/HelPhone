#!/usr/bin/env node
/**
 * Spike #606 — offline routing benchmark (feeds ADR-006).
 *
 * Generates a ~50 MB GeoJSON road network (~100k intersections), loads it
 * into the packed CSR format, then measures for Dijkstra, A* (Euclidean)
 * and Contraction Hierarchies:
 *   - query latency (p50 / p95 / max), node expansions, edge relaxations
 *   - GC pauses observed while querying
 *   - worker off-loading: main-thread event-loop delay with the same query
 *     batch run inline vs. inside a worker, and graph hand-off cost for
 *     structured clone vs. transfer vs. SharedArrayBuffer.
 *
 * Usage:
 *   node --expose-gc scripts/spikes/routing_benchmark.js [--rows 317]
 *        [--queries 200] [--skip-ch] [--out docs/spikes/results/routing-benchmark.json]
 */

import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { constants as perfConstants, PerformanceObserver, monitorEventLoopDelay, performance } from "node:perf_hooks";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import os from "node:os";

import {
  aStar,
  buildContractionHierarchy,
  buildGraphFromGeoJSON,
  chShortestPath,
  createChQueryContext,
  createRng,
  createSearchContext,
  dijkstra,
  generateRoadNetworkGeoJSON,
  packContractionHierarchy,
  packGraph,
  unpackGraph,
} from "../../src/utils/graphTraversal.js";
import {
  createRoutingState,
  handleRoutingMessage,
} from "../../src/workers/routingWorker.js";

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
  return { n: s.length, mean: +mean.toFixed(3), p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), max: +s[s.length - 1].toFixed(3) };
}

const mb = (bytes) => +(bytes / 1024 / 1024).toFixed(2);
const heapUsed = () => {
  if (global.gc) global.gc();
  return process.memoryUsage().heapUsed;
};

function createGcRecorder() {
  const pauses = [];
  // Ignore the collections we force ourselves (global.gc) to sample heap.
  const record = (e) => {
    if (!(e.detail?.flags & perfConstants.NODE_PERFORMANCE_GC_FLAGS_FORCED)) pauses.push(e.duration);
  };
  const obs = new PerformanceObserver((list) => list.getEntries().forEach(record));
  obs.observe({ entryTypes: ["gc"] });
  return {
    // GC entries are delivered asynchronously: yield one tick before reading.
    async take() {
      await new Promise((r) => setImmediate(r));
      obs.takeRecords().forEach(record);
      const out = pauses.splice(0);
      return { count: out.length, totalMs: +out.reduce((a, b) => a + b, 0).toFixed(2), maxMs: +Math.max(0, ...out).toFixed(2) };
    },
    stop: () => obs.disconnect(),
  };
}

function rpc(worker, msg, transfer = []) {
  return new Promise((resolve, reject) => {
    const onMessage = (reply) => {
      if (reply.id !== msg.id) return;
      worker.off("message", onMessage);
      if (reply.type === "error") reject(new Error(reply.message));
      else resolve(reply);
    };
    worker.on("message", onMessage);
    worker.postMessage(msg, transfer);
  });
}

async function main() {
  const rows = Number(arg("rows", 317));
  const queryCount = Number(arg("queries", 200));
  const skipCh = Boolean(arg("skip-ch", false));
  const outPath = arg("out", null);
  const log = (...a) => console.log("[routing]", ...a);
  const results = {
    spike: "#606",
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      cpu: os.cpus()[0]?.model,
      cores: os.cpus().length,
      totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1),
      exposeGc: Boolean(global.gc),
    },
    params: { rows, cols: rows, queryCount },
  };

  // ── 1. Dataset: GeoJSON text → parsed → CSR → packed buffer ──────────────
  const gc = createGcRecorder();
  let t = performance.now();
  const text = JSON.stringify(generateRoadNetworkGeoJSON({ rows, cols: rows }));
  log(`generated GeoJSON ${mb(text.length)} MB in ${(performance.now() - t).toFixed(0)} ms`);
  await gc.take();

  const heap0 = heapUsed();
  t = performance.now();
  let geojson = JSON.parse(text);
  const parseMs = performance.now() - t;
  const featureCount = geojson.features.length;
  const heapParsed = heapUsed();
  t = performance.now();
  const built = buildGraphFromGeoJSON(geojson);
  const buildMs = performance.now() - t;
  geojson = null;
  const packed = packGraph(built);
  const graph = unpackGraph(packed);
  const heapGraph = heapUsed();
  const loadGc = await gc.take();
  results.dataset = {
    geojsonMB: mb(text.length),
    features: featureCount,
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    parseMs: +parseMs.toFixed(1),
    buildMs: +buildMs.toFixed(1),
    parsedGeoJSONHeapMB: mb(heapParsed - heap0),
    packedGraphMB: mb(packed.byteLength),
    heapAfterBuildMB: mb(heapGraph - heap0),
    gcDuringLoad: loadGc,
  };
  log("dataset", results.dataset);

  // ── 2. Query set (identical pairs for every algorithm) ────────────────────
  const rng = createRng(606);
  const pairs = [];
  const ctx = createSearchContext(graph.nodeCount);
  while (pairs.length < queryCount) {
    const s = Math.floor(rng() * graph.nodeCount);
    const d = Math.floor(rng() * graph.nodeCount);
    if (s !== d && dijkstra(graph, s, d, { context: ctx }).distance < Infinity) pairs.push([s, d]);
  }

  const runAlgo = async (name, fn) => {
    for (let i = 0; i < Math.min(10, pairs.length); i++) fn(...pairs[i]); // warm-up JIT
    await gc.take();
    const lat = [];
    let expanded = 0;
    let relaxed = 0;
    const distances = [];
    const heapBefore = process.memoryUsage().heapUsed;
    for (const [s, d] of pairs) {
      const t0 = performance.now();
      const r = fn(s, d);
      lat.push(performance.now() - t0);
      expanded += r.expanded;
      relaxed += r.relaxed;
      distances.push(r.distance);
    }
    const out = {
      latencyMs: stats(lat),
      avgExpanded: Math.round(expanded / pairs.length),
      avgRelaxed: Math.round(relaxed / pairs.length),
      heapGrowthMB: mb(process.memoryUsage().heapUsed - heapBefore),
      gc: await gc.take(),
    };
    log(name, out);
    return { out, distances };
  };

  const dj = await runAlgo("dijkstra", (s, d) => dijkstra(graph, s, d, { context: ctx }));
  const as = await runAlgo("astar", (s, d) => aStar(graph, s, d, { context: ctx }));
  results.algorithms = { dijkstra: dj.out, astar: as.out };
  const agree = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  results.correctness = { astarMatchesDijkstra: agree(dj.distances, as.distances) };

  let chBuffer = null;
  if (!skipCh) {
    const heapBeforeCh = heapUsed();
    t = performance.now();
    let lastLog = 0;
    const ch = buildContractionHierarchy(graph, {
      onProgress: (p) => {
        if (performance.now() - lastLog > 10000) {
          lastLog = performance.now();
          log(`CH contracted ${p.contracted}/${p.total}, shortcuts ${p.shortcutCount}`);
        }
      },
    });
    const chBuildMs = performance.now() - t;
    chBuffer = packContractionHierarchy(ch);
    const buildGc = await gc.take();
    const chCtx = createChQueryContext(graph.nodeCount);
    const chRun = await runAlgo("ch", (s, d) => chShortestPath(ch, s, d, { context: chCtx }));
    results.algorithms.ch = {
      ...chRun.out,
      preprocessMs: +chBuildMs.toFixed(0),
      shortcutCount: ch.shortcutCount,
      packedMB: mb(chBuffer.byteLength),
      preprocessHeapPeakApproxMB: mb(process.memoryUsage().heapUsed - heapBeforeCh),
      gcDuringPreprocess: buildGc,
    };
    results.correctness.chMatchesDijkstra = agree(dj.distances, chRun.distances);
  }

  // ── 3. Worker off-loading ────────────────────────────────────────────────
  results.worker = await benchmarkWorker(graph, packed, chBuffer, pairs, log);
  gc.stop();

  log("correctness", results.correctness);
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
    log(`wrote ${outPath}`);
  }
}

async function benchmarkWorker(graph, packed, chBuffer, pairs, log) {
  const out = {};
  const FRAME_MS = 1000 / 60;

  // Hand-off cost of the graph buffer.
  const handoff = async (label, makeMsg) => {
    const worker = new Worker(new URL(import.meta.url));
    await rpc(worker, { id: 0, type: "ping" }); // exclude worker boot time
    const { msg, transfer } = makeMsg();
    const t0 = performance.now();
    await rpc(worker, msg, transfer);
    const ms = performance.now() - t0;
    await worker.terminate();
    return [label, +ms.toFixed(2)];
  };
  const shared = new SharedArrayBuffer(packed.byteLength);
  new Uint8Array(shared).set(new Uint8Array(packed));
  out.graphHandoffMs = Object.fromEntries([
    await handoff("structuredClone", () => ({ msg: { id: 1, type: "load", graph: packed.slice(0) }, transfer: [] })),
    await handoff("transfer", () => {
      const copy = packed.slice(0);
      return { msg: { id: 1, type: "load", graph: copy }, transfer: [copy] };
    }),
    await handoff("sharedArrayBuffer", () => ({ msg: { id: 1, type: "load", graph: shared }, transfer: [] })),
  ]);
  log("graph hand-off ms", out.graphHandoffMs);

  // Main-thread responsiveness: event-loop delay while computing the batch.
  const measureLoop = async (fn) => {
    const h = monitorEventLoopDelay({ resolution: 1 });
    h.enable();
    // A "frame" tick keeps the loop busy so blocking shows up in the histogram.
    let frames = 0;
    const ticker = setInterval(() => frames++, FRAME_MS);
    const t0 = performance.now();
    await fn();
    const wallMs = performance.now() - t0;
    clearInterval(ticker);
    h.disable();
    const expectedFrames = Math.floor(wallMs / FRAME_MS);
    return {
      wallMs: +wallMs.toFixed(1),
      loopDelayP99Ms: +(h.percentile(99) / 1e6).toFixed(2),
      loopDelayMaxMs: +(h.max / 1e6).toFixed(2),
      framesDelivered: frames,
      framesExpected: expectedFrames,
    };
  };

  const ctx = createSearchContext(graph.nodeCount);
  out.inlineAStar = await measureLoop(async () => {
    // Yield between queries like a well-behaved UI-thread implementation.
    for (const [s, d] of pairs) {
      aStar(graph, s, d, { context: ctx });
      await new Promise((r) => setImmediate(r));
    }
  });

  const worker = new Worker(new URL(import.meta.url));
  await rpc(worker, { id: 0, type: "load", graph: shared, ch: chBuffer ? chBuffer.slice(0) : undefined });
  const roundTrips = [];
  const computeInWorker = [];
  out.workerAStar = await measureLoop(async () => {
    let id = 1;
    for (const [s, d] of pairs) {
      const t0 = performance.now();
      const r = await rpc(worker, { id: id++, type: "route", from: s, to: d, algorithm: "astar" });
      roundTrips.push(performance.now() - t0);
      computeInWorker.push(r.elapsedMs);
    }
  });
  out.workerAStar.roundTripMs = stats(roundTrips);
  out.workerAStar.messagingOverheadMs = stats(roundTrips.map((v, i) => v - computeInWorker[i]));

  if (chBuffer) {
    const rt = [];
    let id = 10_000;
    for (const [s, d] of pairs) {
      const t0 = performance.now();
      await rpc(worker, { id: id++, type: "route", from: s, to: d, algorithm: "ch" });
      rt.push(performance.now() - t0);
    }
    out.workerCHRoundTripMs = stats(rt);
  }
  await worker.terminate();
  log("inline A*", out.inlineAStar);
  log("worker A*", out.workerAStar);
  return out;
}

if (!isMainThread) {
  // Worker side: adapt the browser worker's pure handler to worker_threads.
  const state = createRoutingState();
  parentPort.on("message", (msg) => {
    const { reply, transfer } = handleRoutingMessage(state, msg);
    parentPort.postMessage(reply, transfer);
  });
} else {
  await main();
}
