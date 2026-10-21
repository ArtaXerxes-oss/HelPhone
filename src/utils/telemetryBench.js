#!/usr/bin/env node
/**
 * Telemetry parser microbenchmark.
 *
 * Compares the JS fallback with the Rust/WASM reader on identical frames and
 * reports per-frame cost + heap growth. Run with --expose-gc for stable heap
 * numbers:
 *
 *   node --expose-gc src/utils/telemetryBench.js --frames 20000 --out docs/benchmarks/telemetry.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFrame, parseBatch } from './binaryParser.js';
import { TelemetryWasmParser } from './binaryParserWasm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
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

function time(label, fn, iterations) {
  const started = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { label, iterations, elapsedMs, perFrameUs: (elapsedMs * 1000) / (iterations * FRAME_COUNT) };
}

const FRAME_COUNT = Number(arg('frames', 10_000));
const ROUNDS = Number(arg('rounds', 3));
const outPath = arg('out', '');

const frames = makeFrames(FRAME_COUNT);
const batch = new Uint8Array(FRAME_COUNT * 40);
frames.forEach((buffer, i) => batch.set(new Uint8Array(buffer), i * 40));

// Warm up both paths.
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
// Warm the WASM object pool once so the timed rounds measure steady state
// (the telemetry worker reuses the same pool for the life of the tab).
if (ready) {
  wasm.parseBatch(batch, FRAME_COUNT, { reuse: true, reuseArray: true });
  wasm.stats.objectsCreated = 0;
  wasm.stats.recycledCount = 0;
  wasm.stats.wasmBatchCalls = 0;
  wasm.stats.wasmParsed = 0;
}

const jsBefore = heap();
const js = time('js', () => parseBatch(batch, FRAME_COUNT), ROUNDS);
const jsAfter = heap();

let wasmResult = null;
let wasmBefore = 0;
let wasmAfter = 0;
if (ready) {
  wasmBefore = heap();
  // Hot path: pooled frame objects + pooled result array. The worker clones
  // the batch synchronously in postMessage, so reuse is safe there.
  wasmResult = time('wasm', () => wasm.parseBatch(batch, FRAME_COUNT, { reuse: true, reuseArray: true }), ROUNDS);
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
    // parseBatch allocates one result object per frame.
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
