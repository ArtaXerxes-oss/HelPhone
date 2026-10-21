// Backend selection for map clustering (issue #608, ADR-008).
//
// Default fallback chain (ADR-008 decision): WebGPU -> Worker -> main thread.
// WebGL2 is opt-in only (`preferred: "webgl2"`): its synchronous readPixels
// blocks the main thread (3.6-9.8 ms measured on Intel Gen7, 51 ms on
// SwiftShader), which is worse than the Worker path until readback is made
// asynchronous (PBO + fenceSync). Failures are recorded rather than thrown so
// the map always renders something.

import { createWebGPUClusterer } from "./webgpuClusterer.js";
import { createWebGL2Clusterer } from "./webgl2Clusterer.js";
import { createMainThreadClusterer, createWorkerClusterer } from "./cpuClusterers.js";

export { createGridParams } from "./gridParams.js";
export { mergeCells } from "./mergeCells.js";
export { binPoints } from "./cpuGridCluster.js";

export const BACKEND_ORDER = ["webgpu", "webgl2", "worker", "cpu"];
export const DEFAULT_CHAIN = ["webgpu", "worker", "cpu"];

export function fallbackChain(preferred = "webgpu") {
  if (preferred === "webgl2") return ["webgl2", "worker", "cpu"];
  const start = DEFAULT_CHAIN.indexOf(preferred);
  return start >= 0 ? DEFAULT_CHAIN.slice(start) : DEFAULT_CHAIN;
}

const defaultFactories = {
  webgpu: (params) => createWebGPUClusterer(params),
  webgl2: (params) => createWebGL2Clusterer(params),
  worker: (params) => createWorkerClusterer(params),
  cpu: (params) => createMainThreadClusterer(params),
};

/**
 * @param {ReturnType<import('./gridParams.js').createGridParams>} params
 * @param {{ preferred?: string, factories?: Partial<typeof defaultFactories> }} [options]
 */
export async function createClusterer(params, { preferred = "webgpu", factories = {} } = {}) {
  const fallbackReasons = [];
  for (const backend of fallbackChain(preferred)) {
    const factory = factories[backend] ?? defaultFactories[backend];
    try {
      const clusterer = await factory(params);
      clusterer.fallbackReasons = fallbackReasons;
      return clusterer;
    } catch (err) {
      fallbackReasons.push({ backend, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  throw new Error(
    `No clustering backend available: ${fallbackReasons.map((f) => `${f.backend}: ${f.reason}`).join("; ")}`,
  );
}
