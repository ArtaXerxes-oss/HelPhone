// Worker-thread and main-thread CPU backends (issue #608, ADR-008).
// Both expose the same { backend, cluster(points) -> { grid, timings } }
// contract as the GPU backends.

import { binPoints } from "./cpuGridCluster.js";
import { cellTotal } from "./gridParams.js";

export function createMainThreadClusterer(params) {
  return {
    backend: "cpu",
    async cluster(points) {
      const t0 = performance.now();
      const grid = binPoints(points, params);
      const computeMs = performance.now() - t0;
      return {
        grid,
        timings: { encodeMs: 0, gpuRoundTripMs: null, gpuPassMs: null, computeMs, readbackMs: 0, totalMs: computeMs },
      };
    },
    get memoryBytes() {
      return 0;
    },
    destroy() {},
  };
}

export function createWorkerClusterer(params, { createWorker } = {}) {
  const spawn =
    createWorker ??
    (() => new Worker(new URL("../../workers/clusterWorker.js", import.meta.url), { type: "module" }));
  if (typeof Worker === "undefined" && !createWorker) {
    throw new Error("Web Workers unavailable");
  }
  const worker = spawn();
  const pending = new Map();
  let nextId = 0;

  worker.onmessage = (event) => {
    const { id, error, grid, computeMs } = event.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (error) entry.reject(new Error(error));
    else entry.resolve({ grid, computeMs });
  };
  worker.onerror = (event) => {
    for (const entry of pending.values()) entry.reject(new Error(event.message || "cluster worker crashed"));
    pending.clear();
  };

  return {
    backend: "worker",
    async cluster(points) {
      const t0 = performance.now();
      // Copy so the caller keeps ownership of its live simulation buffer.
      const copy = points.slice();
      const id = nextId++;
      const result = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, points: copy, params }, [copy.buffer]);
      });
      const totalMs = performance.now() - t0;
      return {
        grid: result.grid,
        timings: {
          encodeMs: 0,
          gpuRoundTripMs: null,
          gpuPassMs: null,
          computeMs: result.computeMs,
          // Structured-clone + scheduling overhead of the worker hop.
          readbackMs: totalMs - result.computeMs,
          totalMs,
          uploadBytes: points.byteLength,
          readbackBytes: cellTotal(params) * 16,
        },
      };
    },
    get memoryBytes() {
      return 0;
    },
    destroy() {
      worker.terminate();
    },
  };
}
