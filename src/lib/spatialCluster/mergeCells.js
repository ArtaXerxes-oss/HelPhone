// Grid-DBSCAN merge step (issue #608).
//
// Turns the per-cell output of any backend into renderable clusters:
// cells holding >= threshold points are "dense" (DBSCAN core cells) and are
// unioned with their 8 neighbours when those are dense too. Sparse cells are
// emitted as-is so no SOS call ever disappears from the map.
//
// threshold = max(minPts, relativeDensity x mean count of occupied cells).
// A fixed minPts alone collapses the whole map into one cluster at 50k
// points, because the background density already exceeds it (ADR-008 §4).
//
// Cost is O(occupied cells), independent of point count.

import { cellTotal } from "./gridParams.js";

function find(parent, i) {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
}

/**
 * @param {{ cellCount: Uint32Array, cellSum: Uint32Array, cellRadius: Uint32Array }} grid
 * @param {ReturnType<import('./gridParams.js').createGridParams>} params
 * @param {{ minPts?: number, relativeDensity?: number }} [options]
 * @returns {Array<{ x: number, y: number, count: number, radius: number, dense: boolean, cells: number }>}
 */
export function mergeCells(grid, params, { minPts = 8, relativeDensity = 0 } = {}) {
  const { originX, originY, cellSize, fixedScale, gridW, gridH } = params;
  const { cellCount, cellSum, cellRadius } = grid;
  const cells = cellTotal(params);

  const parent = new Int32Array(cells);
  const occupied = [];
  for (let c = 0; c < cells; c++) {
    parent[c] = c;
    if (cellCount[c] > 0) occupied.push(c);
  }

  let occupiedTotal = 0;
  for (const c of occupied) occupiedTotal += cellCount[c];
  const meanOccupied = occupied.length ? occupiedTotal / occupied.length : 0;
  const threshold = Math.max(minPts, Math.ceil(relativeDensity * meanOccupied));
  const isDense = (c) => cellCount[c] >= threshold;
  for (const c of occupied) {
    if (!isDense(c)) continue;
    const gx = c % gridW;
    const gy = (c - gx) / gridW;
    // Only look "forward" (E, SW, S, SE) so each neighbour pair is visited once.
    const neighbours = [
      [gx + 1, gy],
      [gx - 1, gy + 1],
      [gx, gy + 1],
      [gx + 1, gy + 1],
    ];
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || ny >= gridH || nx >= gridW) continue;
      const nc = ny * gridW + nx;
      if (!isDense(nc)) continue;
      const a = find(parent, c);
      const b = find(parent, nc);
      if (a !== b) parent[b] = a;
    }
  }

  // Per-cell centroid (world space) and radius.
  const centroid = (c) => {
    const gx = c % gridW;
    const gy = (c - gx) / gridW;
    const denom = cellCount[c] * fixedScale;
    return [
      originX + gx * cellSize + cellSum[c * 2] / denom,
      originY + gy * cellSize + cellSum[c * 2 + 1] / denom,
    ];
  };

  const groups = new Map();
  for (const c of occupied) {
    const root = find(parent, c);
    let g = groups.get(root);
    if (!g) {
      g = { members: [], count: 0, sx: 0, sy: 0 };
      groups.set(root, g);
    }
    const [cx, cy] = centroid(c);
    const n = cellCount[c];
    g.members.push({ cx, cy, r: cellRadius[c] / fixedScale });
    g.count += n;
    g.sx += cx * n;
    g.sy += cy * n;
  }

  const clusters = [];
  for (const [root, g] of groups) {
    const x = g.sx / g.count;
    const y = g.sy / g.count;
    let radius = 0;
    for (const m of g.members) {
      radius = Math.max(radius, Math.hypot(m.cx - x, m.cy - y) + m.r);
    }
    clusters.push({ x, y, count: g.count, radius, dense: isDense(root), cells: g.members.length });
  }
  return clusters;
}
