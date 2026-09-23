#!/usr/bin/env node
// Browser benchmark driver for the spatial-clustering spike (issue #608).
//
// Starts a Vite dev server, opens /lab/cluster-bench?autorun=1 in Chromium
// once per backend (+ the raw Canvas 2D baseline) and prints the JSON
// summaries collected by src/components/WebGPUMap.jsx.
//
//   node scripts/bench/cluster-browser-bench.mjs [--points 50000] [--headed]
//     [--backends webgpu,webgl2,worker,cpu,raw]
//
// Headless Chromium usually has no hardware GPU: WebGPU/WebGL then run on
// SwiftShader (software). Use --headed on a real machine for representative
// numbers; the adapter description in the output tells you which you got.
// Set CHROME_PATH to use an existing Chrome/Chromium instead of Playwright's.

/* global process, console */

import { createServer } from "vite";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const points = Number(argValue("--points", "50000"));
const headed = args.includes("--headed");

const allRuns = {
  webgpu: { backend: "webgpu", mode: "clusters" },
  webgl2: { backend: "webgl2", mode: "clusters" },
  worker: { backend: "worker", mode: "clusters" },
  cpu: { backend: "cpu", mode: "clusters" },
  raw: { backend: "cpu", mode: "raw" },
};
const runs = argValue("--backends", Object.keys(allRuns).join(","))
  .split(",")
  .map((name) => allRuns[name.trim()])
  .filter(Boolean);

const server = await createServer({ server: { port: 0, open: false }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");

const browser = await chromium.launch({
  headless: !headed,
  executablePath: process.env.CHROME_PATH || undefined,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});

const results = [];
try {
  for (const run of runs) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const url = `${base}/lab/cluster-bench?autorun=1&points=${points}&backend=${run.backend}&mode=${run.mode}`;
    await page.goto(url);
    const result = await page.waitForFunction(() => globalThis.__clusterBench, null, { timeout: 60_000, polling: 500 });
    results.push(await result.jsonValue());
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(JSON.stringify(results, null, 2));
