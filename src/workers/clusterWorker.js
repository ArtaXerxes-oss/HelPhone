// CPU worker fallback for spatial clustering (issue #608, ADR-008).
// Runs the grid stage off the main thread when neither WebGPU nor a
// float-blendable WebGL2 context is available.

import { binPoints } from "../lib/spatialCluster/cpuGridCluster.js";

self.onmessage = (event) => {
  const { id, points, params } = event.data;
  try {
    const t0 = performance.now();
    const { cellCount, cellSum, cellRadius } = binPoints(points, params);
    const computeMs = performance.now() - t0;
    self.postMessage(
      { id, grid: { cellCount, cellSum, cellRadius }, computeMs },
      [cellCount.buffer, cellSum.buffer, cellRadius.buffer],
    );
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
