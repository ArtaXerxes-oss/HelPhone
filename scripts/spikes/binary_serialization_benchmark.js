#!/usr/bin/env node
/**
 * Spike (ADR-014): deserialization throughput and GC benchmark for live-map
 * telemetry in JSON, Protocol Buffers, FlatBuffers and Cap'n Proto.
 *
 * A stream of `--rate` map objects per second (default 10,000) arrives as
 * frames of `--frame-sizes` objects (default 100, 1000 and 10000, i.e.
 * 100 Hz, 10 Hz and 1 Hz). Each incoming frame is a freshly allocated
 * buffer, as with WebSocket or fetch. The last decoded frame is kept alive
 * until the next one arrives, as the map's state would be.
 *
 * Every (scenario, frame size) pair runs in its own child process so JIT
 * state and heap shape don't leak between runs. Two phases per run:
 *
 *   A. Throughput + GC (unpaced): `--seconds` of stream as fast as possible.
 *      Per-frame decode time, objects/s, and every GC from v8.GCProfiler
 *      (type, main-thread pause, heap bytes allocated, external bytes).
 *   B. Paced (real time): `--paced-seconds` at the real arrival rate with a
 *      60 Hz tick. Per-tick main-thread work (GC inside the work included)
 *      and event-loop delay, as a proxy for dropped map frames.
 *
 * Usage:
 *   node --expose-gc --experimental-transform-types \
 *     scripts/spikes/binary_serialization_benchmark.js \
 *     [--rate 10000] [--seconds 30] [--paced-seconds 10] \
 *     [--frame-sizes 100,1000,10000] [--repeats 3] [--only json/,flatbuffers/] \
 *     [--resume] [--child-heap-mb 3072] \
 *     [--libs <node_modules with flatbuffers + protobufjs>] \
 *     [--out docs/spikes/results/binary-serialization.json]
 *
 * --libs (plus FLATC on PATH) adds rows for the official flatbuffers runtime
 * (reading through flatc --ts output) and for protobufjs.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import { deflateRawSync } from "node:zlib";

import {
  FORMATS,
  FlatMapObject,
  CapnpMapObject,
  createPositionBuffer,
  createRng,
  decodeFrame,
  decodeJson,
  encodeFrame,
  generateMapObjects,
  openCapnpFrame,
  openFlatBuffersFrame,
  readPositions,
  stepMapObjects,
} from "../../src/utils/binaryParser.js";
import { createWasmPositionReader } from "../../src/utils/binaryParserWasm.js";
import { loadOfficialCodecs } from "./binary_official_codecs.js";

const SELF = fileURLToPath(import.meta.url);
const WASM_PATH = new URL("../../src/wasm/telemetry_reader.wasm", import.meta.url);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

/**
 * Access patterns:
 *   positions     render path: id/kind/status/lat/lng/heading into typed arrays
 *   flyweight-positions  the same fields read through FlatMapObject, which
 *                 resolves the vtable on every access like flatc output
 *   wasm          same, done by src/wasm/telemetry_reader.wasm (copy-in included)
 *   fields        zero-copy flyweight reading every scalar and every trail
 *                 value, but no strings (flatc-style accessors)
 *   materialize   plain JS objects for everything, strings included
 *   access-one    time to open a frame and read one field of one random object
 */
const SCENARIOS = [
  { name: "json/materialize", format: "json", mode: "materialize" },
  { name: "json/positions", format: "json", mode: "positions" },
  { name: "protobuf/materialize", format: "protobuf", mode: "materialize" },
  { name: "protobuf/positions", format: "protobuf", mode: "positions" },
  { name: "flatbuffers/positions", format: "flatbuffers", mode: "positions" },
  { name: "flatbuffers/flyweight-positions", format: "flatbuffers", mode: "flyweight-positions" },
  { name: "flatbuffers/fields", format: "flatbuffers", mode: "fields" },
  { name: "flatbuffers/materialize", format: "flatbuffers", mode: "materialize" },
  { name: "flatbuffers/wasm", format: "flatbuffers", mode: "wasm" },
  { name: "capnp/positions", format: "capnp", mode: "positions" },
  { name: "capnp/fields", format: "capnp", mode: "fields" },
  { name: "capnp/materialize", format: "capnp", mode: "materialize" },
  { name: "capnp/wasm", format: "capnp", mode: "wasm" },
  { name: "flatbuffers-official/positions", format: "flatbuffers", mode: "official-positions", codec: "flatbuffers-official" },
  { name: "protobufjs/positions", format: "protobuf", mode: "official-positions", codec: "protobufjs" },
  { name: "protobufjs/materialize", format: "protobuf", mode: "official-materialize", codec: "protobufjs" },
];

function stats(samples) {
  if (!samples.length) return null;
  const s = Float64Array.from(samples).sort();
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const r = (x) => +x.toFixed(4);
  return { n: s.length, mean: r(mean), p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(s[s.length - 1]) };
}

/** Summarises v8.GCProfiler output: pauses by type and bytes allocated. */
function summariseGc(profile, heapAtStart, externalAtStart, heapAtEnd, externalAtEnd) {
  const byType = {};
  const pauses = [];
  let allocated = 0;
  let prevUsed = heapAtStart;
  let externalChurn = 0;
  let prevExternal = externalAtStart;
  for (const s of profile.statistics) {
    const before = s.beforeGC.heapStatistics;
    const after = s.afterGC.heapStatistics;
    allocated += Math.max(0, before.usedHeapSize - prevUsed);
    prevUsed = after.usedHeapSize;
    externalChurn += Math.max(0, before.externalMemory - prevExternal);
    prevExternal = after.externalMemory;
    const ms = s.cost / 1000;
    pauses.push(ms);
    const t = (byType[s.gcType] ??= { count: 0, totalMs: 0, maxMs: 0 });
    t.count++;
    t.totalMs += ms;
    t.maxMs = Math.max(t.maxMs, ms);
  }
  allocated += Math.max(0, heapAtEnd - prevUsed);
  externalChurn += Math.max(0, externalAtEnd - prevExternal);
  for (const t of Object.values(byType)) {
    t.totalMs = +t.totalMs.toFixed(3);
    t.maxMs = +t.maxMs.toFixed(3);
  }
  return {
    count: pauses.length,
    totalMs: +pauses.reduce((a, b) => a + b, 0).toFixed(3),
    maxMs: +Math.max(0, ...pauses).toFixed(3),
    over4ms: pauses.filter((p) => p > 4).length,
    over16ms: pauses.filter((p) => p > 16.7).length,
    byType,
    heapAllocatedBytes: allocated,
    externalAllocatedBytes: externalChurn,
  };
}

// ---------------------------------------------------------------------------
// Child: one scenario at one frame size

async function makeProcessor(scenario, frameSize, libs) {
  const { format, mode } = scenario;
  const out = createPositionBuffer(frameSize);
  let sink = 0;

  if (mode === "positions") {
    return { run: (b) => { readPositions(format, b, out); sink += out.latE6[out.count - 1] | 0; return b; }, sink: () => sink };
  }
  if (mode === "wasm") {
    const reader = await createWasmPositionReader(readFileSync(WASM_PATH), { initialCapacity: frameSize, initialInputBytes: 1 << 20 });
    return { run: (b) => { reader.readPositions(format, b); sink += reader.positions.latE6[reader.positions.count - 1] | 0; return b; }, sink: () => sink };
  }
  if (mode === "materialize") {
    // JSON: what the app does today (plain JSON.parse, trail stays an array).
    const decode = format === "json" ? decodeJson : (b) => decodeFrame(format, b);
    return { run: (b) => { const f = decode(b); sink += f.objects.length; return f; }, sink: () => sink };
  }
  if (mode === "flyweight-positions") {
    const m = new FlatMapObject();
    return {
      run: (b) => {
        const f = openFlatBuffersFrame(b);
        const n = f.objectsLength();
        for (let i = 0; i < n; i++) {
          f.object(i, m);
          out.id[i] = m.id(); out.kind[i] = m.kind(); out.status[i] = m.status();
          out.latE6[i] = m.latE6(); out.lngE6[i] = m.lngE6(); out.headingCdeg[i] = m.headingCdeg();
        }
        out.count = n;
        sink += out.latE6[n - 1] | 0;
        return b;
      },
      sink: () => sink,
    };
  }
  if (mode === "fields") {
    const open = format === "flatbuffers" ? openFlatBuffersFrame : openCapnpFrame;
    const m = format === "flatbuffers" ? new FlatMapObject() : new CapnpMapObject();
    return {
      run: (b) => {
        const f = open(b);
        const n = f.objectsLength();
        let acc = f.seq() + f.sentAtMs();
        for (let i = 0; i < n; i++) {
          f.object(i, m);
          acc += m.id() + m.kind() + m.status() + m.priority() + m.latE6() + m.lngE6() + m.headingCdeg() + m.speedCms() + m.etaSeconds() + m.requestId() + m.tsMs();
          const len = m.trailLength();
          for (let k = 0; k < len; k++) acc += m.trail(k);
        }
        sink += acc % 7;
        return b;
      },
      sink: () => sink,
    };
  }
  if (mode === "official-positions" || mode === "official-materialize") {
    const codecs = await loadOfficialCodecs(libs);
    const c = codecs[scenario.codec];
    if (!c) return null;
    if (mode === "official-positions") return { label: c.label, run: (b) => { c.readPositions(b, out); sink += out.latE6[out.count - 1] | 0; return b; }, sink: () => sink };
    return { label: c.label, run: (b) => { const f = c.decodeFrame(b); sink += f.objects.length; return f; }, sink: () => sink };
  }
  throw new Error(`unknown mode ${mode}`);
}

function buildPool(format, frameSize, poolSize) {
  const objects = generateMapObjects(frameSize, { seed: 42 });
  const rng = createRng(7);
  const pool = [];
  for (let i = 0; i < poolSize; i++) {
    pool.push(encodeFrame(format, { seq: i, sentAtMs: 1_790_000_000_000 + i * 100, objects }));
    stepMapObjects(objects, rng);
  }
  return pool;
}

/** Random-access latency: bytes -> one field of object k, for 2,000 random k. */
function accessOne(format, pool, frameSize) {
  const rng = createRng(99);
  const samples = [];
  const fm = new FlatMapObject();
  const cm = new CapnpMapObject();
  let sink = 0;
  for (let i = 0; i < 2000; i++) {
    const b = pool[i % pool.length];
    const k = (rng() * frameSize) | 0;
    const t = performance.now();
    if (format === "flatbuffers") sink += openFlatBuffersFrame(b).object(k, fm).latE6();
    else if (format === "capnp") sink += openCapnpFrame(b).object(k, cm).latE6();
    else if (format === "json") sink += decodeJson(b).objects[k].latE6;
    else sink += decodeFrame("protobuf", b).objects[k].latE6;
    samples.push(performance.now() - t);
  }
  return { ...stats(samples.slice(200)), sink };
}

async function child() {
  const name = arg("scenario");
  const frameSize = Number(arg("frame-size"));
  const rate = Number(arg("rate", 10000));
  const seconds = Number(arg("seconds", 30));
  const pacedSeconds = Number(arg("paced-seconds", 10));
  const libs = arg("libs");
  const scenario = SCENARIOS.find((s) => s.name === name);
  const proc = await makeProcessor(scenario, frameSize, libs);
  if (!proc) return { skipped: "official codec not available (pass --libs and put flatc on PATH)" };

  const poolSize = frameSize >= 10000 ? 4 : 16;
  const pool = buildPool(scenario.format, frameSize, poolSize);
  const frameBytes = pool[0].length;
  const totalFrames = Math.max(10, Math.round((seconds * rate) / frameSize));
  // Warm up on a fixed object count so every frame size reaches optimised
  // (TurboFan) code before measuring; 30 frames of 1,000 objects does not.
  const warmFrames = Math.max(20, Math.ceil(500_000 / frameSize));

  // The pool is the "network". Every frame arrives as a new ArrayBuffer.
  const deliver = (i) => pool[i % poolSize].slice();

  let latest = null;
  for (let i = 0; i < warmFrames; i++) latest = proc.run(deliver(i));

  // A forced full GC clears weak references embedded in optimised code
  // ("embedded weak objects cleared" in --trace-deopt), which deoptimises
  // the readers. Collect first, then re-warm, then measure.
  const settle = () => {
    global.gc?.();
    for (let i = 0; i < warmFrames; i++) latest = proc.run(deliver(i));
  };

  // Phase A: unpaced throughput + GC
  settle();
  const heap0 = v8.getHeapStatistics();
  const profiler = new v8.GCProfiler();
  profiler.start();
  const samples = new Array(totalFrames);
  const t0 = performance.now();
  for (let i = 0; i < totalFrames; i++) {
    const incoming = deliver(i);
    const t = performance.now();
    latest = proc.run(incoming);
    samples[i] = performance.now() - t;
  }
  const wallMs = performance.now() - t0;
  const heap1 = v8.getHeapStatistics();
  const gc = summariseGc(profiler.stop(), heap0.used_heap_size, heap0.external_memory, heap1.used_heap_size, heap1.external_memory);
  const decodeMs = samples.reduce((a, b) => a + b, 0);
  const objects = totalFrames * frameSize;

  // Phase B: paced at the real arrival rate, 60 Hz ticks
  settle();
  const frameIntervalMs = (1000 * frameSize) / rate;
  const tickMs = 1000 / 60;
  const tickWork = [];
  const eld = monitorEventLoopDelay({ resolution: 1 });
  const pacedProfiler = new v8.GCProfiler();
  const pHeap0 = v8.getHeapStatistics();
  pacedProfiler.start();
  eld.enable();
  await new Promise((resolve) => {
    const start = performance.now();
    let delivered = 0;
    let ticks = 0;
    const tick = () => {
      const now = performance.now();
      const due = Math.min(Math.floor((now - start) / frameIntervalMs) + 1, Math.round((pacedSeconds * 1000) / frameIntervalMs));
      const t = performance.now();
      while (delivered < due) latest = proc.run(deliver(delivered++));
      tickWork.push(performance.now() - t);
      ticks++;
      if (now - start >= pacedSeconds * 1000) return resolve();
      setTimeout(tick, Math.max(0, start + ticks * tickMs - performance.now()));
    };
    tick();
  });
  eld.disable();
  const pHeap1 = v8.getHeapStatistics();
  const pacedGc = summariseGc(pacedProfiler.stop(), pHeap0.used_heap_size, pHeap0.external_memory, pHeap1.used_heap_size, pHeap1.external_memory);
  const ns = (x) => +(x / 1e6).toFixed(3);

  const result = {
    scenario: name,
    label: proc.label,
    frameSize,
    frameBytes,
    frames: totalFrames,
    objects,
    decodeMsPerFrame: stats(samples),
    nsPerObject: +((decodeMs * 1e6) / objects).toFixed(1),
    objectsPerSecond: Math.round(objects / (decodeMs / 1000)),
    mainThreadShareAtRate: +((decodeMs / (objects / rate)) / 1000).toFixed(5),
    wallMs: +wallMs.toFixed(1),
    gc: {
      ...gc,
      heapAllocatedBytesPerObject: +(gc.heapAllocatedBytes / objects).toFixed(1),
      externalAllocatedBytesPerObject: +(gc.externalAllocatedBytes / objects).toFixed(1),
      pausesPerStreamSecond: +(gc.count / seconds).toFixed(2),
      pauseMsPerStreamSecond: +(gc.totalMs / seconds).toFixed(3),
    },
    paced: {
      seconds: pacedSeconds,
      tickWorkMs: stats(tickWork),
      ticksOver4ms: tickWork.filter((w) => w > 4).length,
      ticksOver16ms: tickWork.filter((w) => w > 16.7).length,
      eventLoopDelayMs: { p50: ns(eld.percentile(50)), p99: ns(eld.percentile(99)), max: ns(eld.max) },
      gc: pacedGc,
    },
    usedHeapAfterMB: +(v8.getHeapStatistics().used_heap_size / 1048576).toFixed(2),
    sink: proc.sink() + (latest ? 1 : 0),
  };
  if (scenario.mode === "positions") result.accessOneMs = accessOne(scenario.format, pool, frameSize);
  return result;
}

// ---------------------------------------------------------------------------
// Parent

function sizes(frameSize) {
  const objects = generateMapObjects(frameSize, { seed: 42 });
  const frame = { seq: 1, sentAtMs: 1_790_000_000_000, objects };
  const out = {};
  for (const f of FORMATS) {
    const b = encodeFrame(f, frame);
    const t = performance.now();
    for (let i = 0; i < 5; i++) encodeFrame(f, frame);
    out[f] = {
      bytes: b.length,
      bytesPerObject: +(b.length / frameSize).toFixed(1),
      deflateBytes: deflateRawSync(b).length,
      encodeMs: +((performance.now() - t) / 5).toFixed(3),
    };
  }
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * One row per (scenario, frame size): medians across repeats, plus the
 * min-max spread of ns/object so readers can see how noisy a number is.
 */
function summarise(runs) {
  const groups = new Map();
  for (const r of runs) {
    if (r.error || r.skipped) continue;
    const key = `${r.scenario}@${r.frameSize}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const rows = [];
  for (const rs of groups.values()) {
    const pick = (f) => +median(rs.map(f)).toFixed(3);
    rows.push({
      scenario: rs[0].scenario,
      frameSize: rs[0].frameSize,
      frameBytes: rs[0].frameBytes,
      repeats: rs.length,
      nsPerObject: pick((r) => r.nsPerObject),
      nsPerObjectRange: [Math.min(...rs.map((r) => r.nsPerObject)), Math.max(...rs.map((r) => r.nsPerObject))],
      objectsPerSecond: Math.round(median(rs.map((r) => r.objectsPerSecond))),
      frameMsP50: pick((r) => r.decodeMsPerFrame.p50),
      frameMsP99: pick((r) => r.decodeMsPerFrame.p99),
      frameMsMax: pick((r) => r.decodeMsPerFrame.max),
      mainThreadShareAtRate: pick((r) => r.mainThreadShareAtRate),
      heapAllocatedBytesPerObject: pick((r) => r.gc.heapAllocatedBytesPerObject),
      externalAllocatedBytesPerObject: pick((r) => r.gc.externalAllocatedBytesPerObject),
      gcPausesPerStreamSecond: pick((r) => r.gc.pausesPerStreamSecond),
      gcPauseMsPerStreamSecond: pick((r) => r.gc.pauseMsPerStreamSecond),
      gcMaxPauseMs: pick((r) => r.gc.maxMs),
      gcMarkCompacts: pick((r) => (r.gc.byType.MarkSweepCompact?.count ?? 0) + (r.gc.byType.IncrementalMarking?.count ?? 0)),
      pacedTicksOver4ms: pick((r) => r.paced.ticksOver4ms),
      pacedTicksOver16ms: pick((r) => r.paced.ticksOver16ms),
      pacedTickMsP99: pick((r) => r.paced.tickWorkMs.p99),
      pacedTickMsMax: pick((r) => r.paced.tickWorkMs.max),
      pacedEventLoopDelayMsP99: pick((r) => r.paced.eventLoopDelayMs.p99),
      pacedGcMaxPauseMs: pick((r) => r.paced.gc.maxMs),
      accessOneMsP50: rs[0].accessOneMs ? pick((r) => r.accessOneMs.p50) : undefined,
      label: rs[0].label,
    });
  }
  return rows;
}

async function parent() {
  const rate = Number(arg("rate", 10000));
  const seconds = Number(arg("seconds", 30));
  const pacedSeconds = Number(arg("paced-seconds", 10));
  const frameSizes = String(arg("frame-sizes", "100,1000,10000")).split(",").map(Number);
  const only = arg("only") ? String(arg("only")).split(",") : null;
  const libs = arg("libs");
  const outPath = arg("out");
  const repeats = Number(arg("repeats", 3));

  const cpu = os.cpus()[0]?.model ?? "unknown";
  const results = {
    meta: {
      date: new Date().toISOString(),
      node: process.version,
      v8: process.versions.v8,
      cpu,
      cores: os.cpus().length,
      memGB: +(os.totalmem() / 2 ** 30).toFixed(1),
      platform: `${os.platform()} ${os.release()}`,
      rate,
      seconds,
      pacedSeconds,
      frameSizes,
      repeats,
    },
    sizes: Object.fromEntries(frameSizes.map((n) => [n, sizes(n)])),
    runs: [],
  };

  // --resume: keep runs already in --out and skip them (a killed run loses
  // at most the scenario in progress).
  const done = new Set();
  if (arg("resume") && outPath && existsSync(outPath)) {
    const prev = JSON.parse(readFileSync(outPath, "utf8"));
    results.runs = prev.runs.filter((r) => !r.error);
    for (const r of results.runs) done.add(`${r.scenario}@${r.frameSize}#${r.rep}`);
    console.log(`resuming: ${done.size} run(s) already recorded`);
  }
  const save = () => {
    if (!outPath) return;
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ ...results, summary: summarise(results.runs) }, null, 2) + "\n");
  };

  const flags = ["--expose-gc", `--max-old-space-size=${arg("child-heap-mb", 3072)}`, "--no-warnings"];
  if (libs) flags.push("--experimental-transform-types");
  // Repeats are interleaved (all scenarios, then all again) so slow drift in
  // CPU frequency or background load hits every scenario alike.
  for (let rep = 0; rep < repeats; rep++) {
    for (const frameSize of frameSizes) {
      for (const s of SCENARIOS) {
        if (only && !only.some((o) => s.name.includes(o))) continue;
        if (s.codec && !libs) continue;
        if (done.has(`${s.name}@${frameSize}#${rep}`)) continue;
        const args = [...flags, SELF, "--child", "--scenario", s.name, "--frame-size", String(frameSize), "--rate", String(rate), "--seconds", String(seconds), "--paced-seconds", String(pacedSeconds)];
        if (libs) args.push("--libs", libs);
        const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 1 << 26, env: process.env });
        if (r.status !== 0) {
          console.error(`✗ ${s.name} @${frameSize}: ${r.stderr}`);
          results.runs.push({ scenario: s.name, frameSize, rep, error: (r.stderr || String(r.signal)).trim().split("\n").slice(-3).join(" ") });
          save();
          continue;
        }
        const res = { rep, ...JSON.parse(r.stdout.trim().split("\n").pop()) };
        results.runs.push(res);
        save();
        if (res.skipped) {
          console.log(`- ${s.name.padEnd(32)} @${String(frameSize).padStart(5)}  skipped: ${res.skipped}`);
          continue;
        }
        console.log(
          `✓ [${rep + 1}/${repeats}] ${s.name.padEnd(32)} @${String(frameSize).padStart(5)}  ` +
            `${String(res.nsPerObject).padStart(7)} ns/obj  p99 ${res.decodeMsPerFrame.p99.toFixed(3).padStart(8)} ms/frame  ` +
            `alloc ${String(res.gc.heapAllocatedBytesPerObject).padStart(6)} B/obj  ` +
            `GC ${String(res.gc.count).padStart(4)} (max ${res.gc.maxMs.toFixed(2)} ms)  ` +
            `paced: >16.7ms ticks ${res.paced.ticksOver16ms}, max tick ${res.paced.tickWorkMs.max.toFixed(2)} ms`,
        );
      }
    }
  }
  save();
  if (outPath) console.log(`\nwrote ${outPath}`);
}

if (process.argv.includes("--child")) {
  const res = await child();
  process.stdout.write(JSON.stringify(res) + "\n");
} else {
  await parent();
}
