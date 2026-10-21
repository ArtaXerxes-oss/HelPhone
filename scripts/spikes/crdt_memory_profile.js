#!/usr/bin/env node
/**
 * Spike #604 — CRDT state-vector pruning vs light OT snapshots (ADR-004).
 *
 * Replays one deterministic stream of 50,000 incident-map mutations
 * (responder coordinates, incident status toggles, creates and resolves)
 * across N responder replicas with intermittent connectivity, through:
 *
 *   crdt-nogc       StateVectorDoc, no pruning (Yjs-like unbounded history)
 *   crdt-prune-all  prune at the causal-stability frontier of ALL replicas
 *   crdt-prune-live prune at the frontier of currently-online replicas;
 *                   returning replicas resync from a snapshot
 *   ot-snapshot     OtServer/OtClient with log compaction + offline coalescing
 *   yjs             real Yjs Y.Map (gc: true) with the same gossip schedule
 *
 * Reports retained heap (per mesh and per single replica), op-log/tombstone
 * counts, reconnect payload sizes, convergence rounds/time and GC pauses.
 *
 * Usage:
 *   node --expose-gc scripts/spikes/crdt_memory_profile.js
 *     [--mutations 50000] [--replicas 20] [--heap-snapshots]
 *     [--out docs/spikes/results/crdt-memory-profile.json]
 *
 * --heap-snapshots writes V8 heap snapshots of one replica (unpruned,
 * pruned, Yjs) and summarises the largest object groups by shallow size.
 */

import { constants as perfConstants, PerformanceObserver, performance } from "node:perf_hooks";
import { writeFileSync, mkdirSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import v8 from "node:v8";

import {
  OtClient,
  OtServer,
  StateVectorDoc,
  stableStateVector,
  stateDigest,
  syncPair,
  wireSize,
} from "../../src/services/crdtSync.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const MUTATIONS = Number(arg("mutations", 50000));
const REPLICAS = Number(arg("replicas", 20));
const OUT = arg("out", null);
const HEAP_SNAPSHOTS = process.argv.includes("--heap-snapshots");
const RESPONDERS = 300;
const INCIDENTS = 150;
const GOSSIP_EVERY = 250;
const PRUNE_EVERY = 2500;
const OFFLINE_SHARE = 0.3;

const mb = (b) => +(b / 1024 / 1024).toFixed(2);
const kb = (b) => +(b / 1024).toFixed(1);
const log = (...a) => console.log("[crdt]", ...a);

function heap() {
  if (global.gc) {
    global.gc();
    global.gc();
  }
  return process.memoryUsage().heapUsed;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Workload ────────────────────────────────────────────────────────────────

function buildWorkload() {
  const rand = rng(604);
  const events = [];
  const offlineWindows = new Map(); // replica → [start, end)
  for (let r = 1; r < REPLICAS; r++) {
    if (rand() < OFFLINE_SHARE) {
      const start = Math.floor(rand() * MUTATIONS * 0.7);
      offlineWindows.set(r, [start, start + 2000 + Math.floor(rand() * 8000)]);
    }
  }
  const liveIncidents = new Set();
  let nextIncident = 0;
  for (let i = 0; i < INCIDENTS / 2; i++) liveIncidents.add(nextIncident++);
  const statuses = ["open", "en_route", "on_scene", "stabilised"];
  for (let i = 0; i < MUTATIONS; i++) {
    const replica = Math.floor(rand() * REPLICAS);
    const roll = rand();
    if (roll < 0.8 || liveIncidents.size === 0) {
      const r = Math.floor(rand() * RESPONDERS);
      events.push([replica, "set", `r:${r}`, { lat: +(6.45 + rand() * 0.1).toFixed(6), lng: +(3.35 + rand() * 0.1).toFixed(6), t: i }]);
    } else if (roll < 0.95) {
      const ids = [...liveIncidents];
      const id = ids[Math.floor(rand() * ids.length)];
      events.push([replica, "patch", `i:${id}`, { status: statuses[Math.floor(rand() * statuses.length)] }]);
    } else if (roll < 0.98 && liveIncidents.size < INCIDENTS) {
      const id = nextIncident++;
      liveIncidents.add(id);
      events.push([replica, "set", `i:${id}`, { status: "open", sev: 1 + Math.floor(rand() * 3) }]);
    } else {
      const ids = [...liveIncidents];
      const id = ids[Math.floor(rand() * ids.length)];
      liveIncidents.delete(id);
      events.push([replica, "del", `i:${id}`]);
    }
  }
  // Seed incidents known to everyone before the stream starts.
  const seed = [];
  for (let id = 0; id < INCIDENTS / 2; id++) seed.push(["set", `i:${id}`, { status: "open", sev: 2 }]);
  return { events, offlineWindows, seed };
}

const isOnline = (windows, r, i) => {
  const w = windows.get(r);
  return !w || i < w[0] || i >= w[1];
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
      return { count: out.length, totalMs: +out.reduce((a, b) => a + b, 0).toFixed(1), maxMs: +Math.max(0, ...out).toFixed(2) };
    },
    stop: () => obs.disconnect(),
  };
}

function summarise(values) {
  if (!values.length) return { n: 0 };
  const s = values.slice().sort((a, b) => a - b);
  return { n: s.length, avgKB: kb(s.reduce((a, b) => a + b, 0) / s.length), maxKB: kb(s[s.length - 1]) };
}

// ── Engines ─────────────────────────────────────────────────────────────────

/** Runs the mesh-gossip schedule over any engine exposing sync/digest. */
async function runMesh(label, { create, mutate, sync, digest, prune, stats }, workload) {
  const { events, offlineWindows, seed } = workload;
  const gc = createGcRecorder();
  const rand = rng(4604);
  const heap0 = heap();
  const t0 = performance.now();
  const replicas = Array.from({ length: REPLICAS }, (_, r) => create(`n${String(r).padStart(2, "0")}`));
  for (const [kind, key, value] of seed) mutate(replicas[0], kind, key, value);
  for (let r = 1; r < REPLICAS; r++) sync(replicas[0], replicas[r]);

  const reconnectBytes = [];
  const wasOffline = new Set();
  let gossipBytes = 0;
  const pruneGc = [];
  for (let i = 0; i < events.length; i++) {
    const [r, kind, key, value] = events[i];
    mutate(replicas[r], kind, key, value); // offline replicas keep editing locally

    if ((i + 1) % GOSSIP_EVERY === 0) {
      const online = [];
      for (let k = 0; k < REPLICAS; k++) {
        if (isOnline(offlineWindows, k, i)) online.push(k);
        else wasOffline.add(k);
      }
      for (const k of online) {
        const peer = online[Math.floor(rand() * online.length)];
        if (peer === k) continue;
        const bytes = sync(replicas[k], replicas[peer]);
        gossipBytes += bytes;
        if (wasOffline.has(k)) {
          reconnectBytes.push(bytes);
          wasOffline.delete(k);
        }
      }
    }
    if (prune && (i + 1) % PRUNE_EVERY === 0) {
      await gc.take();
      const t = performance.now();
      prune(replicas, (k) => isOnline(offlineWindows, k, i));
      pruneGc.push({ ms: performance.now() - t, gc: await gc.take() });
    }
  }
  const mutateMs = performance.now() - t0;
  const heapMesh = heap();
  const midStats = stats ? stats(replicas[0]) : null;

  // Convergence: everyone online, gossip rounds until all digests agree.
  const t1 = performance.now();
  let rounds = 0;
  let convergeBytes = 0;
  while (new Set(replicas.map(digest)).size > 1 && rounds < 50) {
    rounds++;
    for (let k = 0; k < REPLICAS; k++) {
      const peer = (k + (1 << ((rounds - 1) % 5))) % REPLICAS; // log-spread pattern
      if (peer !== k) convergeBytes += sync(replicas[k], replicas[peer]);
    }
  }
  const convergeMs = performance.now() - t1;
  const converged = new Set(replicas.map(digest)).size === 1;

  let finalPrune = null;
  if (prune) {
    await gc.take();
    const t = performance.now();
    prune(replicas, () => true);
    finalPrune = { ms: +(performance.now() - t).toFixed(1), gc: await gc.take() };
  }
  const heapAfter = heap();
  const one = replicas[0];
  replicas.length = 0;
  const heapOne = heap();
  const result = {
    engine: label,
    mutateMs: +mutateMs.toFixed(0),
    heapMeshMB: mb(heapMesh - heap0),
    heapMeshAfterConvergeMB: mb(heapAfter - heap0),
    heapPerReplicaAvgMB: +(mb(heapAfter - heap0) / REPLICAS).toFixed(2),
    // Below ~0.5 MB this is dominated by measurement noise; clamp at 0.
    heapSingleReplicaMB: Math.max(0, mb(heapOne - heap0)),
    replica0Stats: stats ? stats(one) : null,
    replica0StatsBeforeConverge: midStats,
    gossipMB: mb(gossipBytes),
    reconnectPayload: summarise(reconnectBytes),
    fullStateKB: one.encodeSnapshot ? kb(wireSize(one.encodeSnapshot())) : null,
    convergence: { converged, rounds, ms: +convergeMs.toFixed(1), MB: mb(convergeBytes) },
    pruneEvents: pruneGc.length
      ? {
          count: pruneGc.length,
          avgMs: +(pruneGc.reduce((a, p) => a + p.ms, 0) / pruneGc.length).toFixed(2),
          maxGcPauseMs: Math.max(...pruneGc.map((p) => p.gc.maxMs)),
        }
      : null,
    finalPrune,
    gcTotal: await gc.take(),
  };
  gc.stop();
  log(label, result);
  return result;
}

const crdtEngine = (pruneMode) => ({
  create: (id) => new StateVectorDoc(id),
  mutate(doc, kind, key, value) {
    if (kind === "del") doc.delete(key);
    else if (kind === "patch") {
      const cur = doc.get(key);
      if (cur) doc.set(key, { ...cur, ...value }); // CRDT has no patch: read-modify-write
    } else doc.set(key, value);
  },
  sync: syncPair,
  digest: (doc) => stateDigest(doc.toMap()),
  stats: (doc) => doc.stats(),
  prune:
    pruneMode === "none"
      ? null
      : (replicas, online) => {
          const members = replicas.filter((_, k) => pruneMode === "all" || online(k));
          const stable = stableStateVector(members.map((d) => d.stateVector()));
          const roster = replicas.map((d) => d.clientId);
          // Offline devices' last known state vectors still gate tombstones.
          const rosterStable = stableStateVector(replicas.map((d) => d.stateVector()));
          for (const d of members) d.prune(stable, roster, rosterStable);
        },
});

async function yjsEngine() {
  let Y;
  try {
    Y = await import("yjs");
  } catch {
    return null;
  }
  return {
    create: (id) => {
      const doc = new Y.Doc({ gc: true });
      doc.clientID = 1000 + Number(id.slice(1));
      return doc;
    },
    mutate(doc, kind, key, value) {
      const m = doc.getMap("m");
      if (kind === "del") m.delete(key);
      else if (kind === "patch") {
        const cur = m.get(key);
        if (cur) m.set(key, { ...cur, ...value });
      } else m.set(key, value);
    },
    sync(a, b) {
      const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
      const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
      Y.applyUpdate(b, toB);
      Y.applyUpdate(a, toA);
      return toB.byteLength + toA.byteLength;
    },
    digest: (doc) => stateDigest(new Map(Object.entries(doc.getMap("m").toJSON()))),
    stats: (doc) => {
      let structs = 0;
      let deleted = 0;
      for (const list of doc.store.clients.values())
        for (const s of list) {
          structs++;
          if (s.deleted) deleted++;
        }
      return { entries: doc.getMap("m").size, structs, deletedStructs: deleted, fullStateBytes: Y.encodeStateAsUpdate(doc).byteLength };
    },
    prune: null,
  };
}

async function runOt(workload) {
  const { events, offlineWindows, seed } = workload;
  const gc = createGcRecorder();
  const heap0 = heap();
  const t0 = performance.now();
  const server = new OtServer({ snapshotEvery: 1000, maxLogOps: 5000 });
  const clients = Array.from({ length: REPLICAS }, (_, r) => new OtClient(`n${r}`));
  for (const [, key, value] of seed) clients[0].set(key, value);
  for (const c of clients) c.sync(server);

  const reconnectBytes = [];
  const purged = [];
  const reconnectGc = [];
  const wasOffline = new Set();
  let bytes = 0;
  for (let i = 0; i < events.length; i++) {
    const [r, kind, key, value] = events[i];
    const c = clients[r];
    if (kind === "del") c.delete(key);
    else if (kind === "patch") c.patch(key, value);
    else c.set(key, value);

    if ((i + 1) % GOSSIP_EVERY === 0) {
      for (let k = 0; k < REPLICAS; k++) {
        if (!isOnline(offlineWindows, k, i)) {
          wasOffline.add(k);
          continue;
        }
        if (wasOffline.has(k)) {
          await gc.take();
          purged.push(clients[k].compactPending());
          const { upBytes, downBytes } = clients[k].sync(server);
          reconnectGc.push((await gc.take()).maxMs);
          reconnectBytes.push(upBytes + downBytes);
          bytes += upBytes + downBytes;
          wasOffline.delete(k);
        } else {
          const { upBytes, downBytes } = clients[k].sync(server);
          bytes += upBytes + downBytes;
        }
      }
    }
  }
  const mutateMs = performance.now() - t0;
  const heapMesh = heap();
  const t1 = performance.now();
  let rounds = 0;
  const target = () => stateDigest(server.state);
  while (clients.some((c) => stateDigest(c.view) !== target()) && rounds < 10) {
    rounds++;
    for (const c of clients) {
      c.compactPending();
      bytes += Object.values(c.sync(server)).reduce((a, b) => a + b, 0);
    }
  }
  const convergeMs = performance.now() - t1;
  const converged = clients.every((c) => stateDigest(c.view) === target());
  const heapAfter = heap();
  const serverStats = server.stats();
  const snapshotKB = kb(wireSize(server.snapshot));
  clients.length = 0;
  const heapServerOnly = heap();
  const result = {
    engine: "ot-snapshot",
    mutateMs: +mutateMs.toFixed(0),
    heapMeshMB: mb(heapMesh - heap0),
    heapMeshAfterConvergeMB: mb(heapAfter - heap0),
    heapSequencerOnlyMB: mb(heapServerOnly - heap0),
    serverStats,
    snapshotKB,
    trafficMB: mb(bytes),
    reconnectPayload: summarise(reconnectBytes),
    offlineOpsPurgedOnReconnect: purged.length ? { reconnects: purged.length, avg: Math.round(purged.reduce((a, b) => a + b, 0) / purged.length), max: Math.max(...purged) } : null,
    reconnectMaxGcPauseMs: reconnectGc.length ? Math.max(...reconnectGc) : 0,
    convergence: { converged, rounds, ms: +convergeMs.toFixed(1) },
    gcTotal: await gc.take(),
  };
  gc.stop();
  log("ot-snapshot", result);
  return result;
}

/** Single-document tombstone growth: 50k overwrites on one replica. */
async function singleDocTombstones() {
  const out = {};
  const run = (label, make, write, statsFn) => {
    const h0 = heap();
    const doc = make();
    const rand = rng(1);
    const t = performance.now();
    for (let i = 0; i < MUTATIONS; i++) write(doc, `r:${Math.floor(rand() * RESPONDERS)}`, { lat: 6.5 + rand() / 10, lng: 3.4 + rand() / 10, t: i });
    out[label] = { writeMs: +(performance.now() - t).toFixed(0), heapMB: mb(heap() - h0), ...statsFn(doc) };
    return doc;
  };
  const svOpts = [
    ["stateVector_gcContent", { gcContent: true }],
    ["stateVector_keepContent", { gcContent: false }],
  ];
  for (const [label, opts] of svOpts)
    run(label, () => new StateVectorDoc("solo", opts), (d, k, v) => d.set(k, v), (d) => ({ ...d.stats(), fullStateKB: kb(wireSize(d.encodeSnapshot())) }));
  try {
    const Y = await import("yjs");
    for (const gcFlag of [true, false])
      run(`yjs_gc_${gcFlag}`, () => new Y.Doc({ gc: gcFlag }), (d, k, v) => d.getMap("m").set(k, v), (d) => ({ updateKB: kb(Y.encodeStateAsUpdate(d).byteLength) }));
  } catch {
    out.yjs = "yjs not installed";
  }
  return out;
}

/**
 * Takes a V8 heap snapshot while `retain` is alive and returns the biggest
 * object groups (type:name → count, shallow MB). Shallow, not retained,
 * sizes — enough to see *what* a replica's heap is made of.
 */
function heapSnapshotSummary(label, retain, top = 8) {
  const dir = mkdtempSync(join(os.tmpdir(), "hp-heap-"));
  heap();
  const file = v8.writeHeapSnapshot(join(dir, `${label}.heapsnapshot`));
  const snap = JSON.parse(readFileSync(file, "utf8"));
  rmSync(dir, { recursive: true, force: true });
  const f = snap.snapshot.meta.node_fields;
  const types = snap.snapshot.meta.node_types[0];
  const [iType, iName, iSize] = ["type", "name", "self_size"].map((n) => f.indexOf(n));
  const groups = new Map();
  let total = 0;
  for (let i = 0; i < snap.nodes.length; i += f.length) {
    const type = types[snap.nodes[i + iType]];
    const name = type === "object" || type === "closure" ? snap.strings[snap.nodes[i + iName]] : `(${type})`;
    const size = snap.nodes[i + iSize];
    total += size;
    const g = groups.get(name) || { count: 0, bytes: 0 };
    g.count++;
    g.bytes += size;
    groups.set(name, g);
  }
  void retain;
  return {
    totalMB: mb(total),
    top: [...groups.entries()]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, top)
      .map(([name, g]) => ({ name, count: g.count, MB: mb(g.bytes) })),
  };
}

async function heapSnapshots() {
  const fill = (write) => {
    const rand = rng(1);
    for (let i = 0; i < MUTATIONS; i++) write(`r:${Math.floor(rand() * RESPONDERS)}`, { lat: 6.5 + rand() / 10, lng: 3.4 + rand() / 10, t: i });
  };
  const out = {};
  out.baseline = heapSnapshotSummary("baseline", null);
  let doc = new StateVectorDoc("solo");
  fill((k, v) => doc.set(k, v));
  out.stateVectorUnpruned = heapSnapshotSummary("sv-unpruned", doc);
  doc.prune(doc.stateVector());
  out.stateVectorPruned = heapSnapshotSummary("sv-pruned", doc);
  doc = null;
  try {
    const Y = await import("yjs");
    const ydoc = new Y.Doc({ gc: true });
    fill((k, v) => ydoc.getMap("m").set(k, v));
    out.yjsGc = heapSnapshotSummary("yjs", ydoc);
  } catch {
    out.yjsGc = "yjs not installed";
  }
  return out;
}

async function main() {
  const results = {
    spike: "#604",
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, cpu: os.cpus()[0]?.model, cores: os.cpus().length, exposeGc: Boolean(global.gc) },
    params: { MUTATIONS, REPLICAS, RESPONDERS, INCIDENTS, GOSSIP_EVERY, PRUNE_EVERY, OFFLINE_SHARE },
  };
  const workload = buildWorkload();
  results.workload = {
    offlineReplicas: workload.offlineWindows.size,
    offlineWindows: Object.fromEntries(workload.offlineWindows),
    mix: workload.events.reduce((acc, e) => ((acc[e[1]] = (acc[e[1]] || 0) + 1), acc), {}),
  };
  log("workload", results.workload);

  results.singleDoc = await singleDocTombstones();
  // Retained heap of one replica before/after pruning its whole history.
  {
    const h0 = heap();
    const d = new StateVectorDoc("solo");
    const rand = rng(1);
    for (let i = 0; i < MUTATIONS; i++) d.set(`r:${Math.floor(rand() * RESPONDERS)}`, { lat: 6.5 + rand() / 10, lng: 3.4 + rand() / 10, t: i });
    const before = heap() - h0;
    const t = performance.now();
    d.prune(d.stateVector());
    const pruneMs = performance.now() - t;
    results.singleDoc.stateVector_pruned = { heapBeforePruneMB: mb(before), heapAfterPruneMB: mb(heap() - h0), pruneMs: +pruneMs.toFixed(1), ...d.stats() };
  }
  log("single doc", results.singleDoc);

  if (HEAP_SNAPSHOTS) {
    results.heapSnapshots = await heapSnapshots();
    log("heap snapshots", JSON.stringify(results.heapSnapshots, null, 1));
  }

  results.mesh = [];
  results.mesh.push(await runMesh("crdt-nogc", crdtEngine("none"), workload));
  results.mesh.push(await runMesh("crdt-prune-all", crdtEngine("all"), workload));
  results.mesh.push(await runMesh("crdt-prune-live", crdtEngine("live"), workload));
  const y = await yjsEngine();
  if (y) results.mesh.push(await runMesh("yjs", y, workload));
  results.mesh.push(await runOt(workload));

  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
    log(`wrote ${OUT}`);
  }
}

await main();
