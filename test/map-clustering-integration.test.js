import { describe, it, expect } from "vitest";
import wgsl from "../src/shaders/clusterShader.wgsl?raw";

import {
  TILE_SIZE,
  clusterToLngLat,
  createViewportGrid,
  hitTestSingleMarker,
  lngLatToWorld,
  projectLatLngPoints,
  updateViewportOrigin,
  viewportOrigin,
  worldToLngLat,
} from "../src/lib/spatialCluster/viewportGrid.js";
import { createClusterer } from "../src/lib/spatialCluster/index.js";
import { createMainThreadClusterer } from "../src/lib/spatialCluster/cpuClusterers.js";
import { mergeCells } from "../src/lib/spatialCluster/mergeCells.js";
import {
  CLUSTER_FIXTURES,
  checkGlslContract,
  checkWgslContract,
  CONFORMANCE_TOLERANCE,
} from "../src/lib/spatialCluster/fixtures.js";
import { WEBGL2_SHADERS, createAsyncReadback } from "../src/lib/spatialCluster/webgl2Clusterer.js";
import { runConformance } from "../src/lib/spatialCluster/conformance.js";
import { STAGING_BUFFER_COUNT, createWebGPUClusterer } from "../src/lib/spatialCluster/webgpuClusterer.js";
import { createClusterTelemetry } from "../src/lib/clusterTelemetry.js";
import { clusterRadius } from "../src/components/ClusteredMapLayer.jsx";

const view = { longitude: 0, latitude: 0, zoom: 2 };
const width = 400;
const height = 200;

globalThis.GPUShaderStage = { COMPUTE: 4 };
globalThis.GPUBufferUsage = {
  MAP_READ: 1,
  COPY_SRC: 2,
  COPY_DST: 4,
  UNIFORM: 8,
  STORAGE: 16,
  QUERY_RESOLVE: 32,
};
globalThis.GPUMapMode = { READ: 1 };

describe("lat/lng -> viewport pixel grid (ADR-008 follow-up 4)", () => {
  it("uses Web Mercator with a 512px tile at zoom 0", () => {
    expect(lngLatToWorld(0, 0, 0)).toEqual({ x: TILE_SIZE / 2, y: TILE_SIZE / 2 });
    expect(lngLatToWorld(-180, 0, 0).x).toBe(0);
    expect(lngLatToWorld(180, 0, 0).x).toBe(TILE_SIZE);
    const round = worldToLngLat(123.4, 250.6, 1);
    const back = lngLatToWorld(round.lng, round.lat, 1);
    expect(back.x).toBeCloseTo(123.4, 4);
    expect(back.y).toBeCloseTo(250.6, 4);
  });

  it("doubles world scale per zoom and clamps latitude", () => {
    expect(lngLatToWorld(0, 0, 3).x).toBe(TILE_SIZE * 4);
    expect(Number.isFinite(lngLatToWorld(0, 89, 2).y)).toBe(true);
  });

  it("projects the view centre to the middle of the viewport", () => {
    const origin = viewportOrigin(view, width, height);
    const centre = lngLatToWorld(view.longitude, view.latitude, view.zoom);
    expect(centre.x - origin.x).toBeCloseTo(width / 2, 6);
    expect(centre.y - origin.y).toBeCloseTo(height / 2, 6);
  });

  it("builds a grid whose origin follows pan/zoom without rebuilding params", () => {
    const points = [
      { id: "a", lat: 0, lng: 0 },
      { id: "b", lat: 0.001, lng: 0.001 },
      { id: "bad", lat: NaN, lng: 0 },
    ];
    const grid = createViewportGrid({ points, viewState: view, width, height, cellSize: 20, maxPoints: 10 });
    expect(grid.params.gridW).toBe(Math.ceil(width / 20));
    expect(grid.params.gridH).toBe(Math.ceil(height / 20));
    expect(grid.ids).toEqual(["a", "b"]);
    expect(grid.pixels).toHaveLength(4);
    expect(grid.pixels[0]).toBeCloseTo(width / 2, 4);

    const zoomed = { ...view, zoom: 3 };
    const origin = updateViewportOrigin(grid.params, zoomed, width, height);
    expect(origin.x).not.toBeCloseTo(grid.origin.x, 4);
    const reprojected = projectLatLngPoints(points, zoomed, width, height);
    expect(reprojected.pixels[0]).toBeCloseTo(width / 2, 4);
  });

  it("hit-tests single markers on CPU data only", () => {
    const points = [
      { id: 1, lat: 0, lng: 0 },
      { id: 2, lat: 1, lng: 1 },
    ];
    const centre = { x: width / 2, y: height / 2 };
    const hit = hitTestSingleMarker({ points, viewState: view, width, height, x: centre.x + 2, y: centre.y + 1 });
    expect(hit.id).toBe(1);
    expect(hit.distancePx).toBeGreaterThan(0);
    expect(hitTestSingleMarker({ points, viewState: view, width, height, x: 0, y: 0, tolerance: 1 })).toBeNull();
    const cluster = { x: centre.x, y: centre.y, count: 2, dense: true, radius: 4 };
    const ll = clusterToLngLat(cluster, view, width, height);
    expect(ll.lat).toBeCloseTo(0, 3);
    expect(ll.lng).toBeCloseTo(0, 3);
  });
});

describe("production pipeline renders clusters, not raw points", () => {
  it("falls back WebGPU -> Worker -> CPU and exposes the reasons", async () => {
    const events = [];
    const telemetry = createClusterTelemetry({ onEvent: (e) => events.push(e) });
    const params = createViewportGrid({
      points: [],
      viewState: view,
      width,
      height,
      cellSize: 20,
      maxPoints: 100,
    }).params;
    const fail = (backend) => () => {
      throw new Error(`${backend} unavailable`);
    };
    const clusterer = await createClusterer(params, {
      factories: {
        webgpu: fail("webgpu"),
        worker: fail("worker"),
        cpu: () => createMainThreadClusterer(params),
      },
    });
    expect(clusterer.backend).toBe("cpu");
    expect(clusterer.fallbackReasons.map((r) => r.backend)).toEqual(["webgpu", "worker"]);
    telemetry.record({
      type: "cluster.backend.selected",
      backend: clusterer.backend,
      fallbackReasons: clusterer.fallbackReasons,
      points: 3,
    });
    expect(telemetry.latestSelection().fallbackReasons[1].reason).toBe("worker unavailable");
    expect(JSON.stringify(events)).not.toContain("undefined");
    telemetry.drain();
    expect(telemetry.history()).toEqual([]);
  });

  it("clusters 50k projected points and preserves every point in the output", async () => {
    const points = Array.from({ length: 50_000 }, (_, i) => ({
      id: i,
      lat: ((i * 37) % 1000) / 100_000 - 0.005,
      lng: ((i * 91) % 1000) / 100_000 - 0.005,
    }));
    const grid = createViewportGrid({ points, viewState: view, width, height, cellSize: 24, maxPoints: points.length });
    const clusterer = await createClusterer(grid.params, { preferred: "cpu" });
    const { grid: binned, timings } = await clusterer.cluster(grid.pixels);
    const clusters = mergeCells(binned, grid.params, { minPts: 8, relativeDensity: 2 });
    expect(clusters.reduce((sum, c) => sum + c.count, 0)).toBe(binned.cellCount.reduce((a, b) => a + b, 0));
    expect(clusters.length).toBeLessThan(points.length / 10);
    expect(timings.computeMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(clusterRadius({ dense: true, count: 64, radius: 100 }))).toBe(true);
  });
});

describe("shared fixtures keep WGSL / GLSL / JS in sync (ADR-008 follow-up 5)", () => {
  it("pins the WGSL contract and GLSL bucketing tokens", () => {
    expect(checkWgslContract(wgsl)).toEqual({ ok: true, errors: [] });
    expect(checkGlslContract(WEBGL2_SHADERS)).toEqual({ ok: true, errors: [] });
    expect(CLUSTER_FIXTURES.length).toBeGreaterThan(0);
    for (const f of CLUSTER_FIXTURES) {
      expect(f.expected.cellCount.length).toBe(f.params.gridW * f.params.gridH);
    }
  });

  it("accepts a backend within tolerance and rejects an out-of-tolerance one", async () => {
    const fixture = CLUSTER_FIXTURES[1];
    const exact = await runConformance({
      backends: [createMainThreadClusterer(fixture.params)],
      params: fixture.params,
      points: fixture.points,
    });
    expect(exact.pass).toBe(true);
    expect(exact.results[0].metrics).toMatchObject({ countMismatchCells: 0, maxCentroidErr: 0 });

    const brokenGrid = {
      cellCount: new Uint32Array(fixture.expected.cellCount.length),
      cellSum: new Uint32Array(fixture.expected.cellSum.length),
      cellRadius: new Uint32Array(fixture.expected.cellRadius.length),
    };
    brokenGrid.cellCount[0] = 1_000_000;
    const broken = await runConformance({
      backends: [{ backend: "broken", cluster: async () => ({ grid: brokenGrid }) }],
      params: fixture.params,
      points: fixture.points,
    });
    expect(broken.pass).toBe(false);
    expect(broken.results[0].metrics.countMismatchCells).toBeGreaterThan(CONFORMANCE_TOLERANCE.maxCountMismatchCells);
  });
});

describe("ping-pong WebGPU readback (ADR-008 follow-up 2)", () => {
  it("uses two staging buffers and allows the next frame while one is mapped", async () => {
    expect(STAGING_BUFFER_COUNT).toBe(2);
    const pendingMaps = [];
    const created = [];
    const makeBuffer = ({ size, usage }) => {
      const buffer = {
        size,
        usage,
        mapAsync: () => new Promise((resolve) => pendingMaps.push(resolve)),
        getMappedRange: () => new ArrayBuffer(size),
        unmap() {},
        destroy() {},
      };
      created.push(buffer);
      return buffer;
    };
    const device = {
      lost: new Promise(() => {}),
      features: { has: () => false },
      destroy() {},
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createComputePipelineAsync: async () => ({}),
      createBuffer: makeBuffer,
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        clearBuffer() {},
        beginComputePass: () => ({ setBindGroup() {}, setPipeline() {}, dispatchWorkgroups() {}, end() {} }),
        copyBufferToBuffer() {},
        finish() {},
      }),
      queue: {
        writeBuffer() {},
        submit() {},
        onSubmittedWorkDone: async () => {},
      },
    };
    const adapter = { info: {}, features: { has: () => false }, requestDevice: async () => device };
    const clusterer = await createWebGPUClusterer(
      { originX: 0, originY: 0, cellSize: 10, fixedScale: 8, gridW: 4, gridH: 2, maxPoints: 100 },
      { navigator: { gpu: { requestAdapter: async () => adapter } } },
    );
    expect(clusterer.stagingBuffers).toBe(2);
    expect(created.filter((b) => (b.usage & globalThis.GPUBufferUsage.MAP_READ) !== 0).length).toBe(2);

    const points = new Float32Array([1, 1, 2, 2]);
    const first = clusterer.cluster(points);
    const second = clusterer.cluster(points);
    expect(clusterer.inFlight).toBe(2);
    pendingMaps[0]();
    pendingMaps[1]();
    const [a, b] = await Promise.all([first, second]);
    expect(a.grid.cellCount).toHaveLength(8);
    expect(b.grid.cellCount).toHaveLength(8);
    expect(clusterer.inFlight).toBe(0);
  });
});

describe("async WebGL2 readback (ADR-008 follow-up 5)", () => {
  it("reads through two PBOs and never blocks on the fence", async () => {
    const calls = { readPixels: [], getBufferSubData: 0, wait: [] };
    const gl = {
      PIXEL_PACK_BUFFER: 1,
      STREAM_READ: 2,
      RGBA: 3,
      FLOAT: 4,
      SYNC_GPU_COMMANDS_COMPLETE: 5,
      ALREADY_SIGNALED: 6,
      CONDITION_SATISFIED: 7,
      WAIT_FAILED: 8,
      createBuffer: () => ({}),
      bindBuffer() {},
      bufferData() {},
      bindFramebuffer() {},
      readPixels(...args) {
        calls.readPixels.push(args);
      },
      fenceSync: () => ({}),
      flush() {},
      clientWaitSync() {
        calls.wait.push(true);
        return 7; // CONDITION_SATISFIED on the first poll
      },
      getBufferSubData() {
        calls.getBufferSubData++;
      },
      deleteSync() {},
      deleteBuffer() {},
    };
    const readback = createAsyncReadback(gl, 64, { setTimeoutFn: (fn) => fn() });
    expect(readback.pbos).toHaveLength(2);
    const pixels = new Float32Array(16);
    const first = await readback.read({}, 2, 2, pixels);
    const second = await readback.read({}, 2, 2, pixels);
    expect(first.blockingMs).toBeLessThan(50);
    expect(first.gpuWaitMs).toBeGreaterThanOrEqual(0);
    expect(second.blockingMs).toBeLessThan(50);
    // Offset 0 (not a JS array) means the PBO is the read destination.
    expect(calls.readPixels.every((args) => args[6] === 0)).toBe(true);
    expect(calls.getBufferSubData).toBe(2);
    readback.destroy();
  });
});
