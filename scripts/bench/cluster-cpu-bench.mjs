#!/usr/bin/env node
// CPU baseline for the spatial-clustering spike (issue #608, ADR-008).
//
// Times the exact grid stage the Worker / main-thread fallbacks run
// (binPoints) plus the merge step every backend runs (mergeCells), on the
// same synthetic workload as /lab/cluster-bench.
//
//   node scripts/bench/cluster-cpu-bench.mjs [--json]

/* global process, console */

import { performance } from "node:perf_hooks";
import os from "node:os";
import { createGridParams } from "../../src/lib/spatialCluster/gridParams.js";
import { binPoints } from "../../src/lib/spatialCluster/cpuGridCluster.js";
import { mergeCells } from "../../src/lib/spatialCluster/mergeCells.js";
import { generateIncidents, stepIncidents } from "../../src/lib/spatialCluster/syntheticIncidents.js";
import { percentile } from "../../src/lib/spatialCluster/benchStats.js";

const WIDTH = 1140;
const HEIGHT = 540;
const CELL_SIZE = 24;
const MIN_PTS = 8;
const RELATIVE_DENSITY = 2;
const SIZES = [5_000, 10_000, 50_000, 100_000, 250_000];
const WARMUP = 30;
const ITERATIONS = 200;

const rows = [];
for (const n of SIZES) {
  const params = createGridParams({ width: WIDTH, height: HEIGHT, cellSize: CELL_SIZE, maxPoints: n });
  const { points, velocity } = generateIncidents(n, { width: WIDTH, height: HEIGHT });
  const bin = [];
  const merge = [];
  let clusters = 0;
  for (let i = 0; i < WARMUP + ITERATIONS; i++) {
    stepIncidents(points, velocity, WIDTH, HEIGHT);
    const t0 = performance.now();
    const grid = binPoints(points, params);
    const t1 = performance.now();
    const out = mergeCells(grid, params, { minPts: MIN_PTS, relativeDensity: RELATIVE_DENSITY });
    const t2 = performance.now();
    if (i >= WARMUP) {
      bin.push(t1 - t0);
      merge.push(t2 - t1);
      clusters = out.filter((c) => c.dense).length;
    }
  }
  const total = bin.map((b, i) => b + merge[i]);
  rows.push({
    points: n,
    binP50: percentile(bin, 50),
    binP95: percentile(bin, 95),
    mergeP50: percentile(merge, 50),
    totalP95: percentile(total, 95),
    denseClusters: clusters,
  });
}

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify({ node: process.version, cpu: os.cpus()[0]?.model, cores: os.cpus().length, rows }, null, 2),
  );
} else {
  console.log(`node ${process.version} · ${os.cpus()[0]?.model} · ${os.cpus().length} cores`);
  console.log(`grid ${Math.ceil(WIDTH / CELL_SIZE)}x${Math.ceil(HEIGHT / CELL_SIZE)} @ ${CELL_SIZE}px, minPts ${MIN_PTS}, relativeDensity ${RELATIVE_DENSITY}, ${ITERATIONS} iterations\n`);
  console.log("| points | binPoints p50 | binPoints p95 | mergeCells p50 | total p95 | dense clusters |");
  console.log("|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    const f = (v) => `${v.toFixed(2)} ms`;
    console.log(
      `| ${r.points.toLocaleString("en-US")} | ${f(r.binP50)} | ${f(r.binP95)} | ${f(r.mergeP50)} | ${f(r.totalP95)} | ${r.denseClusters} |`,
    );
  }
}
