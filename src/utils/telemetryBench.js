/**
 * In-browser telemetry decode benchmark (spike, ADR-014).
 *
 * Streams map-object frames at `rate` objects per second into a
 * requestAnimationFrame loop. Each rAF callback decodes every frame that
 * is due and plots all objects into a canvas, as the live map would. The
 * result reports rAF frame intervals (dropped / long frames), per-frame
 * decode cost and JS heap growth.
 *
 * Used by the /lab/telemetry-bench route (src/components/TelemetryLab.jsx)
 * and by the headless driver scripts/spikes/binary_browser_benchmark.js,
 * which adds GC pause data from a Chrome trace.
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
} from "./binaryParser.js";
import { createWasmPositionReader } from "./binaryParserWasm.js";

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
const now = () => performance.now();

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
    // Without cross-origin isolation browsers coarsen performance.now() to
    // ~100 us, so per-frame decode times for small frames are quantised.
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
  };
}

/**
 * Burst-realistic load profile for anomaly threshold tuning (#773).
 * Steady-state benches understate emergency traffic; this returns a
 * sequence of rates that spike then settle, matching field dispatch bursts.
 */
export function burstLoadProfile({
  baselineRate = 200,
  peakRate = 5000,
  seconds = 30,
} = {}) {
  const points = [];
  for (let t = 0; t < seconds; t++) {
    let rate = baselineRate;
    if (t >= 8 && t < 14) rate = peakRate; // six-second flood
    else if (t >= 14 && t < 18) rate = Math.round(peakRate * 0.35);
    points.push({ t, rate });
  }
  return Object.freeze(points);
}
