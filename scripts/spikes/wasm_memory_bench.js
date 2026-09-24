#!/usr/bin/env node
// Spike #602: cross-sandbox transfer cost for a 10 MB audio payload.
//
// PROTOTYPE: to be discarded once ADR-002 is accepted.
//
//   node scripts/spikes/wasm_memory_bench.js [--mb 10] [--runs 50] [--json]
//
// Compares moving an encrypted-audio buffer from the audio sandbox into the
// ZK sandbox (src/utils/wasmLoader.js) with:
//   multi-memory      bridge module running memory.copy between the two memories
//   js-copy           Uint8Array.set between the two memory buffers (fallback)
//   slice+write       copy out to a detached JS buffer, then into the target
//                     (what code does when it only holds one sandbox at a time)
//   structuredClone   cost of cloning the payload, i.e. a postMessage to a Worker
//                     without transfer (lower bound for cross-thread isolation)
// and, as the no-isolation baseline, passing a pointer within one memory.
//
// The browser engine matrix in ADR-002 comes from running detectFeatures()
// in each browser; this script measures whichever engine runs it (V8 in Node).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  createIsolatedSandboxes,
  detectFeatures,
} from "../../src/utils/wasmLoader.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const arg = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i === -1 ? dflt : Number(args[i + 1]);
};
const MB = arg("--mb", 10);
const RUNS = arg("--runs", 50);
const WARMUP = 5;
const BYTES = MB * 1024 * 1024;

const source = readFileSync(join(ROOT, "src/wasm/memory_sandbox.wasm"));

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const median = q(0.5);
  return {
    median,
    p95: q(0.95),
    min: s[0],
    gbps: BYTES / (median / 1000) / 1e9,
  };
}

async function bench(label, setup, op, verify) {
  const ctx = await setup();
  const samples = [];
  for (let i = 0; i < WARMUP + RUNS; i++) {
    ctx.before?.();
    const t0 = performance.now();
    const out = op(ctx);
    const dt = performance.now() - t0;
    if (i === 0 && verify && !verify(ctx, out))
      throw new Error(`${label}: payload corrupted in transfer`);
    if (i >= WARMUP) samples.push(dt);
  }
  return { label, ...stats(samples) };
}

function payload() {
  // Deterministic stand-in for encrypted audio (high-entropy bytes).
  const buf = new Uint8Array(BYTES);
  let x = 0x602;
  for (let i = 0; i < BYTES; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    buf[i] = x & 0xff;
  }
  return buf;
}

async function sandboxCtx(strategy, data) {
  const s = await createIsolatedSandboxes({ source, strategy });
  const src = s.audio.write(data);
  const expected = s.audio.checksum(src, BYTES);
  // Keep the zk heap from growing across runs; the wipe runs outside the timer.
  return { s, src, expected, before: () => s.zk.reset() };
}

const verifyZk = (ctx, dst) => ctx.s.zk.checksum(dst, BYTES) === ctx.expected;

const data = payload();
const features = detectFeatures();
const results = [];

results.push(
  await bench(
    "no isolation: pointer pass (single memory)",
    () => sandboxCtx("js-copy", data),
    (ctx) => ctx.src,
    (ctx, p) => ctx.s.audio.checksum(p, BYTES) === ctx.expected,
  ),
);

if (features.multiMemory) {
  results.push(
    await bench(
      "multi-memory memory.copy",
      () => sandboxCtx("multi-memory", data),
      (ctx) => ctx.s.transfer(ctx.s.audio, ctx.s.zk, ctx.src, BYTES),
      verifyZk,
    ),
  );
}

results.push(
  await bench(
    "js-copy (Uint8Array.set)",
    () => sandboxCtx("js-copy", data),
    (ctx) => ctx.s.transfer(ctx.s.audio, ctx.s.zk, ctx.src, BYTES),
    verifyZk,
  ),
);

results.push(
  await bench(
    "slice + write (one sandbox at a time)",
    () => sandboxCtx("js-copy", data),
    (ctx) => ctx.s.zk.write(ctx.s.audio.read(ctx.src, BYTES)),
    verifyZk,
  ),
);

results.push(
  await bench(
    "structuredClone (postMessage w/o transfer)",
    async () => ({ data }),
    (ctx) => structuredClone(ctx.data),
    (ctx, out) =>
      out.byteLength === BYTES && out[BYTES - 1] === ctx.data[BYTES - 1],
  ),
);

const env = `Node ${process.version} / V8 ${process.versions.v8}`;
if (args.includes("--json")) {
  console.log(
    JSON.stringify(
      { env, bytes: BYTES, runs: RUNS, features, results },
      null,
      2,
    ),
  );
} else {
  console.log(`## WASM cross-memory transfer, ${MB} MB payload (#602)\n`);
  console.log(
    `Engine: ${env}. Runs: ${RUNS} (+${WARMUP} warmup). Features: ${JSON.stringify(features)}\n`,
  );
  console.log(
    "| Strategy | Median (ms) | p95 (ms) | Min (ms) | Throughput (GB/s) |",
  );
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const r of results) {
    const gbps = r.median < 0.001 ? "n/a" : r.gbps.toFixed(2);
    console.log(
      `| ${r.label} | ${r.median.toFixed(3)} | ${r.p95.toFixed(3)} | ${r.min.toFixed(3)} | ${gbps} |`,
    );
  }
}
