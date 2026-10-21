/**
 * In-browser telemetry decode benchmark (spike, ADR-014)
 * and CLI telemetry parser microbenchmark (ISP-032).
 */

import {
  FlatMapObject,
  createPositionBuffer,
  createRng,
  decodeJson,
  decodeFrame,
  encodeFrame,
  generateMapObjects,
  openFlatBuffersFrame,
  readPositions,
  stepMapObjects,
  parseBatch,
} from "./binaryParser.js";
import { createWasmPositionReader, TelemetryWasmParser } from "./binaryParserWasm.js";

export const BENCH_SCENARIOS = [
  "json/materialize",
  "protobuf/materialize",
  "protobuf/positions",
  "flatbuffers/positions",
  "flatbuffers/fields",
  "flatbuffers/wasm",
  "capnp/positions",
  "capnp/wasm",
];

const FRAME_MS = 1000 / 60;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function summary(samples) {
  if (!samples.length) return null;
  const s = Float64Array.from(samples).sort();
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const r = (x) => +x.toFixed(3);
  return { n: s.length, mean: r(s.reduce((a, b) => a + b, 0) / s.length), p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(s[s.length - 1]) };
}

/** Builds the per-frame decode + plot step for one scenario. */
async function makeStep(scenario, frameSize, wasmUrl, plot) {
  const [format, mode] = scenario.split("/");
  const out = createPositionBuffer(frameSize);
  const plotPositions = (p) => {
    for (let i = 0; i < p.count; i++) plot(p.latE6[i], p.lngE6[i], p.kind[i]);
  };
  if (mode === "positions") {
    return (bytes) => {
      readPositions(format, bytes, out);
      plotPositions(out);
    };
  }
  if (mode === "wasm") {
    const reader = await createWasmPositionReader(fetch(wasmUrl), { initialCapacity: frameSize, initialInputBytes: 1 << 20 });
    return (bytes) => {
      reader.readPositions(format, bytes);
      plotPositions(reader.positions);
    };
  }
  if (mode === "fields") {
    const m = new FlatMapObject();
    return (bytes) => {
      const f = openFlatBuffersFrame(bytes);
      const n = f.objectsLength();
      for (let i = 0; i < n; i++) {
        f.object(i, m);
        plot(m.latE6(), m.lngE6(), m.kind());
      }
    };
  }
  // materialize: what the app does with JSON today.
  const decode = format === "json" ? decodeJson : (b) => decodeFrame(format, b);
  return (bytes) => {
    const objects = decode(bytes).objects;
    for (let i = 0; i < objects.length; i++) plot(objects[i].latE6, objects[i].lngE6, objects[i].kind);
  };
}

/**
 * Runs one scenario. Resolves with the measurements. `canvas` is optional
 * (an offscreen one is created); pass one to watch the points move.
 */
export async function runTelemetryBench({
  scenario = "flatbuffers/positions",
  frameSize = 1000,
  rate = 10_000,
  seconds = 10,
  warmupObjects = 300_000,
  canvas,
  wasmUrl,
  onProgress,
} = {}) {
  const [format] = scenario.split("/");
  const width = canvas?.width || 480;
  const height = canvas?.height || 320;
  const ctx = (canvas || (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : document.createElement("canvas"))).getContext("2d");
  const image = ctx.createImageData(width, height);
  const pixels = new Uint32Array(image.data.buffer);

  const objects = generateMapObjects(frameSize, { seed: 42 });
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const o of objects) {
    minLat = Math.min(minLat, o.latE6); maxLat = Math.max(maxLat, o.latE6);
    minLng = Math.min(minLng, o.lngE6); maxLng = Math.max(maxLng, o.lngE6);
  }
  const sx = (width - 1) / Math.max(1, maxLng - minLng);
  const sy = (height - 1) / Math.max(1, maxLat - minLat);
  const COLORS = [0xff6b7aff, 0xff4e4b23]; // ABGR: coral requests, teal responders
  const plot = (lat, lng, kind) => {
    const x = ((lng - minLng) * sx) | 0;
    const y = ((maxLat - lat) * sy) | 0;
    if (x >= 0 && x < width && y >= 0 && y < height) pixels[y * width + x] = COLORS[kind & 1];
  };

  const rng = createRng(7);
  const poolSize = frameSize >= 10_000 ? 4 : 16;
  const pool = [];
  for (let i = 0; i < poolSize; i++) {
    pool.push(encodeFrame(format, { seq: i, sentAtMs: Date.now(), objects }));
    stepMapObjects(objects, rng);
  }
  // Every frame arrives as a new ArrayBuffer, as from WebSocket/fetch.
  const deliver = (i) => pool[i % poolSize].slice();
  const step = await makeStep(scenario, frameSize, wasmUrl, plot);

  const warmFrames = Math.max(20, Math.ceil(warmupObjects / frameSize));
  for (let i = 0; i < warmFrames; i++) step(deliver(i));
  // A forced GC deoptimises hot code (see the Node benchmark), so re-warm.
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    for (let i = 0; i < warmFrames; i++) step(deliver(i));
  }

  const heapBefore = performance.memory?.usedJSHeapSize ?? null;
  const frameIntervalMs = (1000 * frameSize) / rate;
  const deltas = [];
  const work = [];
  const decode = [];
  let delivered = 0;
  performance.mark("telemetry-bench-start");

  await new Promise((resolve) => {
    const start = now();
    let last = start;
    const total = Math.round((seconds * 1000) / frameIntervalMs);
    const tick = () => {
      const t = now();
      deltas.push(t - last);
      last = t;
      const due = Math.min(total, Math.floor((t - start) / frameIntervalMs) + 1);
      if (delivered < due) pixels.fill(0);
      while (delivered < due) {
        const bytes = deliver(delivered++);
        const d0 = now();
        step(bytes);
        decode.push(now() - d0);
      }
      ctx.putImageData(image, 0, 0);
      work.push(now() - t);
      if (onProgress && deltas.length % 30 === 0) onProgress(Math.min(1, (t - start) / (seconds * 1000)));
      if (t - start >= seconds * 1000) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  performance.mark("telemetry-bench-end");
  const intervals = deltas.slice(1);
  return {
    scenario,
    frameSize,
    rate,
    seconds,
    frameBytes: pool[0].length,
    frames: delivered,
    rafIntervalMs: summary(intervals),
    // A rAF interval of 1.5x the 60 Hz budget or more means a frame was missed.
    droppedFrames: intervals.reduce((n, d) => n + Math.max(0, Math.round(d / FRAME_MS) - 1), 0),
    longFrames50ms: intervals.filter((d) => d > 50).length,
    workPerRafMs: summary(work),
    decodePerFrameMs: summary(decode),
    nsPerObject: +((decode.reduce((a, b) => a + b, 0) * 1e6) / (delivered * frameSize)).toFixed(1),
    heapBeforeMB: heapBefore === null ? null : +(heapBefore / 1048576).toFixed(2),
    heapAfterMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(2) : null,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
  };
}

/**
 * Burst-realistic load profile for anomaly threshold tuning (#773).
 */
export function burstLoadProfile({
  baselineRate = 200,
  peakRate = 5000,
  seconds = 30,
} = {}) {
  const points = [];
  for (let t = 0; t < seconds; t++) {
    let rate = baselineRate;
    if (t >= 8 && t < 14) rate = peakRate;
    else if (t >= 14 && t < 18) rate = Math.round(peakRate * 0.35);
    points.push({ t, rate });
  }
  return Object.freeze(points);
}

// ===========================================================================
// CLI benchmark entry point
// ===========================================================================

async function runCliBenchmark() {
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const ROOT = resolve(__dirname, '../..');

  function arg(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1) return fallback;
    return process.argv[index + 1] ?? fallback;
  }

  function makeFrames(count) {
    const buffers = [];
    for (let i = 0; i < count; i++) {
      buffers.push(
        encodeFrame({
          kind: i % 10 === 0 ? 4 : i % 3 === 0 ? 3 : 1,
          priority: i % 10 === 0 ? 2 : i % 3 === 0 ? 0 : 1,
          seq: i,
          ts: 1_700_000_000_000 + i,
          lat: 6.5 + (i % 100) * 1e-4,
          lng: 3.3 + (i % 100) * 1e-4,
          accuracy: 3 + (i % 20),
        }),
      );
    }
    return buffers;
  }

  function heap() {
    if (typeof global.gc === 'function') global.gc();
    return process.memoryUsage().heapUsed;
  }

  function time(label, fn, iterations, frameCount) {
    const started = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) fn();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { label, iterations, elapsedMs, perFrameUs: (elapsedMs * 1000) / (iterations * frameCount) };
  }

  const FRAME_COUNT = Number(arg('frames', 10_000));
  const ROUNDS = Number(arg('rounds', 3));
  const outPath = arg('out', '');

  const frames = makeFrames(FRAME_COUNT);
  const batch = new Uint8Array(FRAME_COUNT * 40);
  frames.forEach((buffer, i) => batch.set(new Uint8Array(buffer), i * 40));

  parseBatch(batch, 512);

  const wasm = new TelemetryWasmParser({
    wasmBytes: (() => {
      try {
        return readFileSync(resolve(ROOT, 'src/wasm/telemetry_reader.wasm'));
      } catch {
        return undefined;
      }
    })(),
    expectedSha256: (() => {
      try {
        return readFileSync(resolve(ROOT, 'src/wasm/telemetry_reader.wasm.sha256'), 'utf8').trim();
      } catch {
        return undefined;
      }
    })(),
    shaUrl: undefined,
    preferWasm: true,
    timeoutMs: 5_000,
  });

  const ready = await wasm.init();
  if (!ready && process.argv.includes('--require-wasm')) {
    console.error('telemetryBench: WASM parser unavailable');
    process.exit(1);
  }

  if (ready) {
    wasm.parseBatch(batch, FRAME_COUNT, { reuse: true, reuseArray: true });
    wasm.stats.objectsCreated = 0;
    wasm.stats.recycledCount = 0;
    wasm.stats.wasmBatchCalls = 0;
    wasm.stats.wasmParsed = 0;
  }

  const jsBefore = heap();
  const js = time('js', () => parseBatch(batch, FRAME_COUNT), ROUNDS, FRAME_COUNT);
  const jsAfter = heap();

  let wasmResult = null;
  let wasmBefore = 0;
  let wasmAfter = 0;
  if (ready) {
    wasmBefore = heap();
    wasmResult = time('wasm', () => wasm.parseBatch(batch, FRAME_COUNT, { reuse: true, reuseArray: true }), ROUNDS, FRAME_COUNT);
    wasmAfter = heap();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    frames: FRAME_COUNT,
    rounds: ROUNDS,
    wasm: {
      available: Boolean(ready),
      mode: wasm.mode,
      stats: wasm.getStats(),
      elapsedMs: wasmResult?.elapsedMs ?? null,
      perFrameUs: wasmResult?.perFrameUs ?? null,
      heapGrowthBytes: ready ? wasmAfter - wasmBefore : null,
      heapGrowthPerFrameBytes: ready ? (wasmAfter - wasmBefore) / FRAME_COUNT : null,
      objectsCreatedPerFrame: ready
        ? wasm.getStats().objectsCreated / (FRAME_COUNT * ROUNDS)
        : null,
      pooledFrames: ready ? wasm.framePool.length : 0,
    },
    js: {
      elapsedMs: js.elapsedMs,
      perFrameUs: js.perFrameUs,
      heapGrowthBytes: jsAfter - jsBefore,
      heapGrowthPerFrameBytes: (jsAfter - jsBefore) / FRAME_COUNT,
      objectsCreatedPerFrame: 1,
    },
    speedup: wasmResult ? js.elapsedMs / wasmResult.elapsedMs : null,
    allocationReduction: ready
      ? (() => {
          const objects = wasm.getStats().objectsCreated / (FRAME_COUNT * ROUNDS);
          return objects === 0 ? null : 1 / objects;
        })()
      : null,
    note: ready
      ? "Steady-state WASM path reuses pooled frame objects; allocationReduction is null when per-frame object creation is zero."
      : "WASM module unavailable; JS fallback measured only.",
  };

  const text = JSON.stringify(report, null, 2);
  if (outPath) {
    const target = resolve(ROOT, outPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${text}\n`);
    console.log(`telemetryBench: wrote ${target}`);
  }
  console.log(text);
}

if (typeof process !== 'undefined' && process.argv?.[1] && process.argv[1].endsWith('telemetryBench.js')) {
  runCliBenchmark().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
