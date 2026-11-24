// Backend conformance against the CPU oracle (ADR-008 decision 5).
// Used by the in-app benchmark and by Node tests with injected backends, so
// WebGPU/WebGL2 results are checked with exactly the same tolerance as CPU.

import { compareGrids } from "./benchStats.js";
import { binPoints } from "./cpuGridCluster.js";
import { CONFORMANCE_TOLERANCE } from "./fixtures.js";

export function isConforming(metrics, tolerance = CONFORMANCE_TOLERANCE) {
  return (
    metrics.countMismatchCells <= tolerance.maxCountMismatchCells &&
    metrics.countDelta <= tolerance.maxCountMismatchCells * 2 &&
    metrics.maxCentroidErr <= tolerance.maxCentroidErrPx &&
    metrics.maxRadiusErr <= tolerance.maxRadiusErrPx
  );
}

/**
 * @param {{ backends: Array<{backend: string, cluster: (p: Float32Array) => Promise<{grid: object}>}>,
 *   params: object, points: Float32Array, tolerance?: object }} input
 */
export async function runConformance({ backends, params, points, tolerance = CONFORMANCE_TOLERANCE }) {
  const expected = binPoints(points, params);
  const results = [];
  for (const backend of backends) {
    try {
      const { grid, timings } = await backend.cluster(points);
      const metrics = compareGrids(grid, expected, params.fixedScale);
      results.push({ backend: backend.backend, pass: isConforming(metrics, tolerance), metrics, timings: timings ?? null });
    } catch (err) {
      results.push({ backend: backend.backend, pass: false, error: err.message, metrics: null, timings: null });
    }
  }
  return {
    pass: results.every((r) => r.pass),
    tolerance,
    results,
  };
}

export const DEFAULT_TOLERANCE = CONFORMANCE_TOLERANCE;
