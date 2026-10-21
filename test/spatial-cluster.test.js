import { describe, it, expect } from "vitest";
import wgsl from "../src/shaders/clusterShader.wgsl?raw";
import {
  OUTSIDE_CELL,
  PARAMS_BYTE_LENGTH,
  WORKGROUP_SIZE,
  createGridParams,
  packParams,
  workgroupCount,
} from "../src/lib/spatialCluster/gridParams.js";
import { binPoints } from "../src/lib/spatialCluster/cpuGridCluster.js";
import { mergeCells } from "../src/lib/spatialCluster/mergeCells.js";
import { generateIncidents, stepIncidents } from "../src/lib/spatialCluster/syntheticIncidents.js";
import { percentile, summariseFrames } from "../src/lib/spatialCluster/benchStats.js";
import { createClusterer, fallbackChain } from "../src/lib/spatialCluster/index.js";
import { createWorkerClusterer } from "../src/lib/spatialCluster/cpuClusterers.js";

// ---------------------------------------------------------------------------
// Spatial clustering spike (#608, ADR-008)
//
// The CPU grid stage is the correctness oracle for the WGSL shader and the
// WebGL2 path, so these tests pin its bucketing, fixed-point sums and the
// merge step, plus the JS <-> WGSL contract and the backend fallback chain.
// ---------------------------------------------------------------------------

const pts = (...xy) => new Float32Array(xy);

describe("createGridParams", () => {
  it("derives grid dimensions from the viewport and cell size", () => {
    const p = createGridParams({ width: 1140, height: 540, cellSize: 24, maxPoints: 50_000 });
    expect(p.gridW).toBe(48);
    expect(p.gridH).toBe(23);
  });

  it("picks a fixedScale that cannot overflow u32 cell sums", () => {
    const p = createGridParams({ width: 100, height: 100, cellSize: 24, maxPoints: 50_000 });
    expect(p.fixedScale).toBeGreaterThanOrEqual(1);
    expect(p.maxPoints * p.cellSize * p.fixedScale).toBeLessThanOrEqual(0xffffffff);
  });

  it("rejects capacities that would overflow even at fixedScale 1", () => {
    expect(() => createGridParams({ width: 10, height: 10, cellSize: 1024, maxPoints: 10_000_000 })).toThrow(
      /overflow/,
    );
  });

  it("rejects non-positive dimensions", () => {
    expect(() => createGridParams({ width: 0, height: 10, cellSize: 1, maxPoints: 1 })).toThrow(RangeError);
  });
});

describe("packParams", () => {
  it("matches the 32-byte WGSL Params layout", () => {
    const p = createGridParams({ width: 96, height: 48, cellSize: 24, originX: 5, originY: 7, maxPoints: 100 });
    const buf = packParams(p, 42);
    expect(buf.byteLength).toBe(PARAMS_BYTE_LENGTH);
    const f32 = new Float32Array(buf);
    const u32 = new Uint32Array(buf);
    expect([f32[0], f32[1], f32[2], f32[3]]).toEqual([5, 7, 24, p.fixedScale]);
    expect([u32[4], u32[5], u32[6]]).toEqual([4, 2, 42]);
  });

  it("dispatches enough workgroups to cover every point", () => {
    expect(workgroupCount(50_000)).toBe(Math.ceil(50_000 / WORKGROUP_SIZE));
    expect(workgroupCount(50_000) * WORKGROUP_SIZE).toBeGreaterThanOrEqual(50_000);
  });
});

describe("binPoints", () => {
  const params = createGridParams({ width: 40, height: 20, cellSize: 10, maxPoints: 100 });

  it("buckets points into row-major cells and marks outside points", () => {
    const { cellCount, pointCell } = binPoints(pts(1, 1, 15, 2, 15, 15, -1, 5, 40, 5), params);
    expect(Array.from(pointCell)).toEqual([0, 1, 5, OUTSIDE_CELL, OUTSIDE_CELL]);
    expect(cellCount[0]).toBe(1);
    expect(cellCount[1]).toBe(1);
    expect(cellCount[5]).toBe(1);
    expect(cellCount.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("accumulates fixed-point in-cell offsets and the spread radius", () => {
    const { cellCount, cellSum, cellRadius } = binPoints(pts(2, 5, 8, 5), params);
    const s = params.fixedScale;
    expect(cellCount[0]).toBe(2);
    // centroid offset = (5, 5) inside cell 0
    expect(cellSum[0] / (2 * s)).toBeCloseTo(5, 5);
    expect(cellSum[1] / (2 * s)).toBeCloseTo(5, 5);
    // both points are 3 units from the centroid
    expect(cellRadius[0] / s).toBeCloseTo(3, 1);
  });
});

describe("mergeCells", () => {
  const params = createGridParams({ width: 100, height: 100, cellSize: 10, maxPoints: 1000 });
  const blob = (cx, cy, n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(cx + (i % 5) * 0.5, cy + Math.floor(i / 5) * 0.5);
    return out;
  };

  it("keeps separated dense blobs as separate clusters", () => {
    const grid = binPoints(new Float32Array([...blob(12, 12, 20), ...blob(72, 72, 20)]), params);
    const dense = mergeCells(grid, params, { minPts: 8 }).filter((c) => c.dense);
    expect(dense).toHaveLength(2);
    expect(dense.map((c) => c.count).sort()).toEqual([20, 20]);
  });

  it("unions adjacent dense cells (incl. diagonals) into one cluster", () => {
    // Blobs in cells (1,1), (2,1) and diagonal (3,2)
    const grid = binPoints(new Float32Array([...blob(12, 12, 10), ...blob(22, 12, 10), ...blob(32, 22, 10)]), params);
    const dense = mergeCells(grid, params, { minPts: 8 }).filter((c) => c.dense);
    expect(dense).toHaveLength(1);
    expect(dense[0].count).toBe(30);
    expect(dense[0].cells).toBe(3);
    expect(dense[0].radius).toBeGreaterThan(10);
  });

  it("never merges sparse cells and preserves the total point count", () => {
    const grid = binPoints(new Float32Array([...blob(12, 12, 20), 55, 55, 57, 55, 95, 5]), params);
    const clusters = mergeCells(grid, params, { minPts: 8 });
    expect(clusters.reduce((a, c) => a + c.count, 0)).toBe(23);
    expect(clusters.filter((c) => !c.dense).length).toBe(2);
  });

  describe("on the 50k synthetic workload", () => {
    const p = createGridParams({ width: 1140, height: 540, cellSize: 24, maxPoints: 50_000 });
    const grid = binPoints(generateIncidents(50_000, { width: 1140, height: 540 }).points, p);

    it("collapses into one cluster with a fixed minPts (background is already dense)", () => {
      expect(mergeCells(grid, p, { minPts: 8 }).filter((c) => c.dense)).toHaveLength(1);
    });

    it("separates hotspots with a density-relative threshold and keeps every point", () => {
      const clusters = mergeCells(grid, p, { minPts: 8, relativeDensity: 2 });
      expect(clusters.reduce((a, c) => a + c.count, 0)).toBe(50_000);
      expect(clusters.filter((c) => c.dense).length).toBeGreaterThan(5);
    });
  });
});

describe("synthetic incidents", () => {
  it("is deterministic for a given seed and stays in bounds while moving", () => {
    const a = generateIncidents(1000, { width: 200, height: 100, seed: 1 });
    const b = generateIncidents(1000, { width: 200, height: 100, seed: 1 });
    expect(Array.from(a.points)).toEqual(Array.from(b.points));
    for (let i = 0; i < 200; i++) stepIncidents(a.points, a.velocity, 200, 100);
    for (let i = 0; i < a.points.length; i += 2) {
      expect(a.points[i]).toBeGreaterThanOrEqual(0);
      expect(a.points[i]).toBeLessThan(200);
      expect(a.points[i + 1]).toBeGreaterThanOrEqual(0);
      expect(a.points[i + 1]).toBeLessThan(100);
    }
  });
});

describe("bench stats", () => {
  it("computes percentiles and dropped-frame share", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    const s = summariseFrames([16, 17, 16, 40]);
    expect(s.frames).toBe(4);
    expect(s.droppedPct).toBe(25);
    expect(s.p99).toBe(40);
  });

  it("handles empty input", () => {
    expect(summariseFrames([]).fps).toBeNull();
  });
});

describe("WGSL <-> JS contract", () => {
  it("shares the workgroup size and OUTSIDE sentinel", () => {
    expect(wgsl).toMatch(new RegExp(`const WORKGROUP_SIZE: u32 = ${WORKGROUP_SIZE}u;`));
    expect(wgsl).toMatch(/const OUTSIDE: u32 = 0xffffffffu;/);
    expect(OUTSIDE_CELL).toBe(0xffffffff);
  });

  it("exposes both entry points and six bindings", () => {
    expect(wgsl).toMatch(/fn assignCells\(/);
    expect(wgsl).toMatch(/fn measureSpread\(/);
    const bindings = [...wgsl.matchAll(/@binding\((\d+)\)/g)].map((m) => Number(m[1]));
    expect(bindings).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("declares Params fields in the order packParams writes them", () => {
    const body = wgsl.match(/struct Params \{([^}]*)\}/)[1];
    const fields = [...body.matchAll(/(\w+):/g)].map((m) => m[1]);
    expect(fields).toEqual(["origin", "cellSize", "fixedScale", "gridW", "gridH", "pointCount", "_pad"]);
  });
});

describe("createClusterer fallback chain", () => {
  const params = createGridParams({ width: 40, height: 20, cellSize: 10, maxPoints: 100 });
  const ok = (backend) => () => ({ backend, cluster: async () => ({}), destroy() {} });
  const fail = (msg) => () => {
    throw new Error(msg);
  };

  it("skips WebGL2 in the default chain (blocking readback, ADR-008)", () => {
    expect(fallbackChain()).toEqual(["webgpu", "worker", "cpu"]);
    expect(fallbackChain("worker")).toEqual(["worker", "cpu"]);
    expect(fallbackChain("webgl2")).toEqual(["webgl2", "worker", "cpu"]);
    expect(fallbackChain("bogus")).toEqual(["webgpu", "worker", "cpu"]);
  });

  it("falls back in order and records why", async () => {
    const webgl2 = () => {
      throw new Error("must not be tried by default");
    };
    const c = await createClusterer(params, {
      factories: { webgpu: fail("no navigator.gpu"), webgl2, worker: fail("no Worker"), cpu: ok("cpu") },
    });
    expect(c.backend).toBe("cpu");
    expect(c.fallbackReasons.map((f) => f.backend)).toEqual(["webgpu", "worker"]);
  });

  it("uses WebGL2 only when explicitly preferred", async () => {
    const c = await createClusterer(params, { preferred: "webgl2", factories: { webgl2: ok("webgl2") } });
    expect(c.backend).toBe("webgl2");
  });

  it("starts from the preferred backend", async () => {
    const c = await createClusterer(params, { preferred: "cpu" });
    expect(c.backend).toBe("cpu");
    const { grid } = await c.cluster(pts(1, 1, 2, 2));
    expect(grid.cellCount[0]).toBe(2);
  });

  it("uses the real WebGPU factory's failure when navigator.gpu is absent", async () => {
    const c = await createClusterer(params, { factories: { worker: fail("y") } });
    expect(c.backend).toBe("cpu");
    expect(c.fallbackReasons[0].reason).toMatch(/navigator\.gpu/);
  });

  it("throws when every backend fails", async () => {
    const all = { webgpu: fail("a"), webgl2: fail("b"), worker: fail("c"), cpu: fail("d") };
    await expect(createClusterer(params, { factories: all })).rejects.toThrow(/No clustering backend/);
  });
});

describe("worker clusterer", () => {
  it("round-trips through the worker protocol without detaching the caller's buffer", async () => {
    const params = createGridParams({ width: 40, height: 20, cellSize: 10, maxPoints: 100 });
    const fakeWorker = {
      postMessage({ id, points, params: p }) {
        const { cellCount, cellSum, cellRadius } = binPoints(points, p);
        queueMicrotask(() => this.onmessage({ data: { id, grid: { cellCount, cellSum, cellRadius }, computeMs: 1 } }));
      },
      terminate() {},
    };
    const c = createWorkerClusterer(params, { createWorker: () => fakeWorker });
    const input = pts(1, 1, 35, 15);
    const { grid, timings } = await c.cluster(input);
    expect(grid.cellCount[0]).toBe(1);
    expect(grid.cellCount[7]).toBe(1);
    expect(timings.computeMs).toBe(1);
    expect(input.length).toBe(4);
  });
});
