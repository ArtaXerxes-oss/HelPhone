// CPU reference for the grid stage of clusterShader.wgsl (issue #608).
//
// Same bucketing and fixed-point quantisation as the GPU, so the output can be
// used as a correctness oracle and as the Worker / main-thread fallback.

import { OUTSIDE_CELL, cellTotal } from "./gridParams.js";

/**
 * @param {Float32Array} points interleaved [x0, y0, x1, y1, ...]
 * @param {ReturnType<import('./gridParams.js').createGridParams>} params
 * @returns {{ cellCount: Uint32Array, cellSum: Uint32Array, cellRadius: Uint32Array, pointCell: Uint32Array }}
 */
export function binPoints(points, params) {
  const { originX, originY, cellSize, fixedScale, gridW, gridH } = params;
  const n = points.length >> 1;
  const cells = cellTotal(params);
  const cellCount = new Uint32Array(cells);
  const cellSum = new Uint32Array(cells * 2);
  const cellRadius = new Uint32Array(cells);
  const pointCell = new Uint32Array(n);
  const maxQ = cellSize * fixedScale;
  const quantize = (v) => Math.min(maxQ, Math.max(0, Math.round(v * fixedScale)));

  // Pass 1 — assignCells
  for (let i = 0; i < n; i++) {
    const x = points[2 * i];
    const y = points[2 * i + 1];
    const gx = Math.floor((x - originX) / cellSize);
    const gy = Math.floor((y - originY) / cellSize);
    if (!(gx >= 0 && gy >= 0 && gx < gridW && gy < gridH)) {
      pointCell[i] = OUTSIDE_CELL;
      continue;
    }
    const cell = gy * gridW + gx;
    pointCell[i] = cell;
    cellCount[cell]++;
    cellSum[cell * 2] += quantize(x - (originX + gx * cellSize));
    cellSum[cell * 2 + 1] += quantize(y - (originY + gy * cellSize));
  }

  // Pass 2 — measureSpread
  for (let i = 0; i < n; i++) {
    const cell = pointCell[i];
    if (cell === OUTSIDE_CELL) continue;
    const gx = cell % gridW;
    const gy = (cell - gx) / gridW;
    const denom = cellCount[cell] * fixedScale;
    const dx = points[2 * i] - (originX + gx * cellSize) - cellSum[cell * 2] / denom;
    const dy = points[2 * i + 1] - (originY + gy * cellSize) - cellSum[cell * 2 + 1] / denom;
    const r = Math.round(Math.hypot(dx, dy) * fixedScale);
    if (r > cellRadius[cell]) cellRadius[cell] = r;
  }

  return { cellCount, cellSum, cellRadius, pointCell };
}
