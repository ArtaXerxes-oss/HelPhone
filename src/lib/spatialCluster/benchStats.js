// Frame-time statistics for the clustering benchmark (issue #608).

export const FRAME_BUDGET_MS = 1000 / 60;

export function percentile(values, p) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function mean(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null;
}

/**
 * @param {number[]} frameMs  rAF-to-rAF deltas
 * @returns {{ frames: number, fps: number|null, p50: number|null, p95: number|null, p99: number|null, droppedPct: number|null }}
 */
export function summariseFrames(frameMs) {
  if (!frameMs.length) return { frames: 0, fps: null, p50: null, p95: null, p99: null, droppedPct: null };
  const total = frameMs.reduce((a, b) => a + b, 0);
  // A frame counts as dropped when it overran the 60 Hz budget by > 50%
  // (i.e. at least one vsync was missed).
  const dropped = frameMs.filter((ms) => ms > FRAME_BUDGET_MS * 1.5).length;
  return {
    frames: frameMs.length,
    fps: (frameMs.length * 1000) / total,
    p50: percentile(frameMs, 50),
    p95: percentile(frameMs, 95),
    p99: percentile(frameMs, 99),
    droppedPct: (dropped / frameMs.length) * 100,
  };
}

/** Summarise one numeric field across a list of per-frame timing objects. */
export function summariseField(samples, field) {
  const values = samples.map((s) => s?.[field]).filter((v) => typeof v === "number");
  return { p50: percentile(values, 50), p95: percentile(values, 95), mean: mean(values), n: values.length };
}

/**
 * Compare a backend's grid against the CPU oracle (binPoints) for the same
 * input. Counts must match exactly except for points sitting on a cell
 * boundary, where f32 (GPU) and f64 (JS) floor() can disagree.
 */
export function compareGrids(actual, expected, fixedScale) {
  let countMismatchCells = 0;
  let countDelta = 0;
  let maxCentroidErr = 0;
  let maxRadiusErr = 0;
  for (let c = 0; c < expected.cellCount.length; c++) {
    const a = actual.cellCount[c];
    const e = expected.cellCount[c];
    if (a !== e) {
      countMismatchCells++;
      countDelta += Math.abs(a - e);
      continue;
    }
    if (!e) continue;
    for (const k of [0, 1]) {
      const err = Math.abs(actual.cellSum[c * 2 + k] - expected.cellSum[c * 2 + k]) / (e * fixedScale);
      maxCentroidErr = Math.max(maxCentroidErr, err);
    }
    maxRadiusErr = Math.max(maxRadiusErr, Math.abs(actual.cellRadius[c] - expected.cellRadius[c]) / fixedScale);
  }
  return { countMismatchCells, countDelta, maxCentroidErr, maxRadiusErr };
}
