// WebGPU backend for the grid-clustering spike (issue #608, ADR-008).
//
// One submit per frame: upload points -> clear cell buffers -> assignCells ->
// measureSpread -> copy cell buffers (not per-point data) into a staging
// buffer -> mapAsync. Only O(cells) bytes cross back to the CPU.

import shaderSource from "../../shaders/clusterShader.wgsl?raw";
import { PARAMS_BYTE_LENGTH, cellTotal, packParams, workgroupCount } from "./gridParams.js";

const TIMESTAMP_BYTES = 16; // two u64 timestamps

export async function isWebGPUAvailable(nav = globalThis.navigator) {
  if (!nav?.gpu) return false;
  try {
    return Boolean(await nav.gpu.requestAdapter());
  } catch {
    return false;
  }
}

export async function createWebGPUClusterer(params, { navigator: nav = globalThis.navigator } = {}) {
  if (!nav?.gpu) throw new Error("WebGPU API not exposed (navigator.gpu missing)");
  const adapter = await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("WebGPU adapter request returned null");

  const hasTimestamps = adapter.features.has("timestamp-query");
  const device = await adapter.requestDevice({
    requiredFeatures: hasTimestamps ? ["timestamp-query"] : [],
  });

  let lost = null;
  device.lost.then((info) => {
    lost = info;
  });

  const module = device.createShaderModule({ code: shaderSource });
  const info = await module.getCompilationInfo?.();
  const errors = info?.messages?.filter((m) => m.type === "error") ?? [];
  if (errors.length) {
    device.destroy();
    throw new Error(`WGSL compile failed: ${errors.map((m) => m.message).join("; ")}`);
  }

  const storage = (readOnly) => ({
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: readOnly ? "read-only-storage" : "storage" },
  });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 1, ...storage(true) },
      { binding: 2, ...storage(false) },
      { binding: 3, ...storage(false) },
      { binding: 4, ...storage(false) },
      { binding: 5, ...storage(false) },
    ],
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const [assignPipeline, spreadPipeline] = await Promise.all(
    ["assignCells", "measureSpread"].map((entryPoint) =>
      device.createComputePipelineAsync({ layout, compute: { module, entryPoint } }),
    ),
  );

  const cells = cellTotal(params);
  const cellBytes = cells * 4;
  const readbackBytes = cellBytes * 4 + (hasTimestamps ? TIMESTAMP_BYTES : 0);
  const S = GPUBufferUsage;

  const paramsBuf = device.createBuffer({ size: PARAMS_BYTE_LENGTH, usage: S.UNIFORM | S.COPY_DST });
  const cellCountBuf = device.createBuffer({ size: cellBytes, usage: S.STORAGE | S.COPY_SRC | S.COPY_DST });
  const cellSumBuf = device.createBuffer({ size: cellBytes * 2, usage: S.STORAGE | S.COPY_SRC | S.COPY_DST });
  const cellRadiusBuf = device.createBuffer({ size: cellBytes, usage: S.STORAGE | S.COPY_SRC | S.COPY_DST });
  const stagingBuf = device.createBuffer({ size: readbackBytes, usage: S.MAP_READ | S.COPY_DST });

  let querySet = null;
  let queryResolveBuf = null;
  if (hasTimestamps) {
    querySet = device.createQuerySet({ type: "timestamp", count: 2 });
    queryResolveBuf = device.createBuffer({ size: TIMESTAMP_BYTES, usage: S.QUERY_RESOLVE | S.COPY_SRC });
  }

  // Point-sized buffers grow on demand; cell-sized buffers are fixed by params.
  let capacity = 0;
  let pointsBuf = null;
  let pointCellBuf = null;
  let bindGroup = null;

  function ensureCapacity(n) {
    if (n <= capacity) return;
    pointsBuf?.destroy();
    pointCellBuf?.destroy();
    capacity = Math.max(n, capacity * 2, 1024);
    pointsBuf = device.createBuffer({ size: capacity * 8, usage: S.STORAGE | S.COPY_DST });
    pointCellBuf = device.createBuffer({ size: capacity * 4, usage: S.STORAGE });
    bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [paramsBuf, pointsBuf, pointCellBuf, cellCountBuf, cellSumBuf, cellRadiusBuf].map(
        (buffer, binding) => ({ binding, resource: { buffer } }),
      ),
    });
  }

  let busy = false;

  async function cluster(points) {
    if (lost) throw new Error(`WebGPU device lost: ${lost.message || lost.reason}`);
    if (busy) throw new Error("cluster() called while a previous frame is still in flight");
    busy = true;
    try {
      const n = points.length >> 1;
      ensureCapacity(n);
      const t0 = performance.now();

      device.queue.writeBuffer(paramsBuf, 0, packParams(params, n));
      device.queue.writeBuffer(pointsBuf, 0, points.buffer, points.byteOffset, n * 8);

      const encoder = device.createCommandEncoder();
      encoder.clearBuffer(cellCountBuf);
      encoder.clearBuffer(cellSumBuf);
      encoder.clearBuffer(cellRadiusBuf);
      const pass = encoder.beginComputePass(
        querySet
          ? { timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }
          : undefined,
      );
      pass.setBindGroup(0, bindGroup);
      const groups = workgroupCount(n);
      pass.setPipeline(assignPipeline);
      pass.dispatchWorkgroups(groups);
      pass.setPipeline(spreadPipeline);
      pass.dispatchWorkgroups(groups);
      pass.end();

      encoder.copyBufferToBuffer(cellCountBuf, 0, stagingBuf, 0, cellBytes);
      encoder.copyBufferToBuffer(cellSumBuf, 0, stagingBuf, cellBytes, cellBytes * 2);
      encoder.copyBufferToBuffer(cellRadiusBuf, 0, stagingBuf, cellBytes * 3, cellBytes);
      if (querySet) {
        encoder.resolveQuerySet(querySet, 0, 2, queryResolveBuf, 0);
        encoder.copyBufferToBuffer(queryResolveBuf, 0, stagingBuf, cellBytes * 4, TIMESTAMP_BYTES);
      }
      device.queue.submit([encoder.finish()]);
      const tSubmitted = performance.now();

      await stagingBuf.mapAsync(GPUMapMode.READ);
      const tMapped = performance.now();
      const mapped = stagingBuf.getMappedRange();
      const cellData = new Uint32Array(mapped.slice(0, cellBytes * 4));
      let gpuPassMs = null;
      if (querySet) {
        const [begin, end] = new BigUint64Array(mapped, cellBytes * 4, 2);
        gpuPassMs = end > begin ? Number(end - begin) / 1e6 : null;
      }
      stagingBuf.unmap();
      const tDone = performance.now();

      return {
        grid: {
          cellCount: cellData.subarray(0, cells),
          cellSum: cellData.subarray(cells, cells * 3),
          cellRadius: cellData.subarray(cells * 3, cells * 4),
        },
        timings: {
          // CPU time to encode + enqueue the upload and dispatch.
          encodeMs: tSubmitted - t0,
          // Upload + compute + copy, as observed by the CPU (queue latency included).
          gpuRoundTripMs: tMapped - tSubmitted,
          // Pure compute-pass time from timestamp queries, when the adapter allows it.
          gpuPassMs,
          // Copying the mapped range into JS memory.
          readbackMs: tDone - tMapped,
          totalMs: tDone - t0,
          uploadBytes: n * 8 + PARAMS_BYTE_LENGTH,
          readbackBytes,
        },
      };
    } finally {
      busy = false;
    }
  }

  /** Upload-only latency: host -> GPU storage buffer, awaited on the queue. */
  async function measureUpload(points) {
    const n = points.length >> 1;
    ensureCapacity(n);
    const t0 = performance.now();
    device.queue.writeBuffer(pointsBuf, 0, points.buffer, points.byteOffset, n * 8);
    await device.queue.onSubmittedWorkDone();
    return performance.now() - t0;
  }

  return {
    backend: "webgpu",
    adapterInfo: adapter.info ?? null,
    timestampQueries: hasTimestamps,
    cluster,
    measureUpload,
    get memoryBytes() {
      return (
        PARAMS_BYTE_LENGTH +
        cellBytes * 4 +
        readbackBytes +
        (hasTimestamps ? TIMESTAMP_BYTES : 0) +
        capacity * 12
      );
    },
    destroy() {
      device.destroy();
    },
  };
}
