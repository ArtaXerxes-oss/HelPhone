// lat/lng <-> viewport pixel grid for the production map (ADR-008 follow-up 4).
//
// The clustering backends work in viewport pixels, not geographic coordinates.
// This module is the only place that knows about Web Mercator projection and
// zoom, so every backend sees the same grid at the same camera position. It is
// deliberately CPU-only and side-effect free: it is also the source of the
// un-clustered point data used for single-marker hit-testing (ADR-008 states
// WebGPU results arrive a frame late and must not be used for hit-tests).

import { createGridParams } from "./gridParams.js";

export const TILE_SIZE = 512;
export const MAX_LATITUDE = 85.05112878;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Web Mercator: geographic coordinate -> world pixel at `zoom`. */
export function lngLatToWorld(lng, lat, zoom, tileSize = TILE_SIZE) {
  const scale = tileSize * 2 ** zoom;
  const x = ((lng + 180) / 360) * scale;
  const clampedLat = clamp(lat, -MAX_LATITUDE, MAX_LATITUDE);
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
  return { x, y };
}

/** Inverse of `lngLatToWorld`, used to place a cluster back on the map. */
export function worldToLngLat(x, y, zoom, tileSize = TILE_SIZE) {
  const scale = tileSize * 2 ** zoom;
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lng, lat };
}

export function readLngLat(point) {
  if (!point) return null;
  const lng = Number.isFinite(point.lng) ? point.lng : point.longitude;
  const lat = Number.isFinite(point.lat) ? point.lat : point.latitude;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
}

/** Top-left world pixel of the viewport for a Mapbox-style view state. */
export function viewportOrigin(viewState, width, height, tileSize = TILE_SIZE) {
  const center = lngLatToWorld(viewState.longitude, viewState.latitude, viewState.zoom, tileSize);
  return { x: center.x - width / 2, y: center.y - height / 2 };
}

/** Mutate `params` in place so a long-lived clusterer sees a pan/zoom change. */
export function updateViewportOrigin(params, viewState, width, height, tileSize = TILE_SIZE) {
  const origin = viewportOrigin(viewState, width, height, tileSize);
  params.originX = origin.x;
  params.originY = origin.y;
  return origin;
}

/**
 * Project geographic points into an interleaved Float32Array of viewport
 * pixels. `ids` and `sourceIndexes` keep the CPU-side mapping so a click can
 * be resolved against the original point without consulting a GPU result.
 */
export function projectLatLngPoints(points, viewState, width, height, { tileSize = TILE_SIZE, maxPoints = Infinity } = {}) {
  const origin = viewportOrigin(viewState, width, height, tileSize);
  const limit = Math.min(points.length, maxPoints);
  const pixels = new Float32Array(limit * 2);
  const ids = [];
  const sourceIndexes = [];
  let n = 0;
  for (let i = 0; i < limit; i++) {
    const ll = readLngLat(points[i]);
    if (!ll) continue;
    const world = lngLatToWorld(ll.lng, ll.lat, viewState.zoom, tileSize);
    pixels[2 * n] = world.x - origin.x;
    pixels[2 * n + 1] = world.y - origin.y;
    ids.push(points[i].id ?? i);
    sourceIndexes.push(i);
    n++;
  }
  return { pixels: pixels.subarray(0, n * 2), ids, sourceIndexes, origin };
}

/**
 * Build the grid params + pixel buffer used by every backend. Params are
 * created once per (size, cellSize, capacity); pan/zoom only mutates the
 * origin, so the WebGPU device / worker is not rebuilt on every camera move.
 */
export function createViewportGrid({
  points,
  viewState,
  width,
  height,
  cellSize = 24,
  maxPoints = points.length,
  tileSize = TILE_SIZE,
}) {
  const params = createGridParams({
    width,
    height,
    cellSize,
    originX: 0,
    originY: 0,
    maxPoints: Math.max(1, maxPoints),
  });
  const projected = projectLatLngPoints(points, viewState, width, height, { tileSize, maxPoints });
  params.originX = projected.origin.x;
  params.originY = projected.origin.y;
  return { params, ...projected };
}

/**
 * Single-marker hit-test. Uses raw geographic points projected on the CPU —
 * never the (possibly one-frame-late) GPU cluster output.
 *
 * @returns {{ id, index, point, distancePx, x, y } | null}
 */
export function hitTestSingleMarker({
  points,
  viewState,
  width,
  height,
  x,
  y,
  tolerance = 12,
  tileSize = TILE_SIZE,
}) {
  const origin = viewportOrigin(viewState, width, height, tileSize);
  let best = null;
  let bestSq = tolerance * tolerance;
  for (let i = 0; i < points.length; i++) {
    const ll = readLngLat(points[i]);
    if (!ll) continue;
    const world = lngLatToWorld(ll.lng, ll.lat, viewState.zoom, tileSize);
    const px = world.x - origin.x;
    const py = world.y - origin.y;
    const d2 = (px - x) ** 2 + (py - y) ** 2;
    if (d2 <= bestSq) {
      bestSq = d2;
      best = { id: points[i].id ?? i, index: i, point: points[i], distancePx: Math.sqrt(d2), x: px, y: py };
    }
  }
  return best;
}

/** Cluster centroid (viewport pixels) back to geographic coordinates. */
export function clusterToLngLat(cluster, viewState, width, height, tileSize = TILE_SIZE) {
  const origin = viewportOrigin(viewState, width, height, tileSize);
  return worldToLngLat(origin.x + cluster.x, origin.y + cluster.y, viewState.zoom, tileSize);
}
