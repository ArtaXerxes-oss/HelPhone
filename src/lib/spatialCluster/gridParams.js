// Shared grid configuration for every clustering backend (issue #608).
// Mirrors the constants and `Params` struct in src/shaders/clusterShader.wgsl.

export const WORKGROUP_SIZE = 256;
export const OUTSIDE_CELL = 0xffffffff;
export const PARAMS_BYTE_LENGTH = 32;

const U32_MAX = 0xffffffff;
const MAX_FIXED_SCALE = 16;

/**
 * Build the grid description used by the shader, the WebGL2 path and the CPU
 * reference. `fixedScale` is the largest power-of-two-ish factor (<= 16) for
 * which `maxPoints` points piled into one cell cannot overflow a u32 sum of
 * quantised offsets (each offset is < cellSize).
 */
export function createGridParams({
  width,
  height,
  cellSize,
  originX = 0,
  originY = 0,
  maxPoints,
}) {
  if (!(width > 0 && height > 0)) throw new RangeError("width and height must be > 0");
  if (!(cellSize > 0)) throw new RangeError("cellSize must be > 0");
  if (!(maxPoints > 0)) throw new RangeError("maxPoints must be > 0");

  const fixedScale = Math.min(MAX_FIXED_SCALE, Math.floor(U32_MAX / (maxPoints * cellSize)));
  if (fixedScale < 1) {
    throw new RangeError(
      `maxPoints (${maxPoints}) x cellSize (${cellSize}) would overflow u32 cell sums`,
    );
  }

  return {
    originX,
    originY,
    cellSize,
    fixedScale,
    gridW: Math.ceil(width / cellSize),
    gridH: Math.ceil(height / cellSize),
    maxPoints,
  };
}

export function cellTotal(params) {
  return params.gridW * params.gridH;
}

/** Serialise params into the 32-byte uniform layout of the WGSL `Params` struct. */
export function packParams(params, pointCount) {
  const buf = new ArrayBuffer(PARAMS_BYTE_LENGTH);
  const f32 = new Float32Array(buf);
  const u32 = new Uint32Array(buf);
  f32[0] = params.originX;
  f32[1] = params.originY;
  f32[2] = params.cellSize;
  f32[3] = params.fixedScale;
  u32[4] = params.gridW;
  u32[5] = params.gridH;
  u32[6] = pointCount;
  u32[7] = 0;
  return buf;
}

export function workgroupCount(pointCount) {
  return Math.ceil(pointCount / WORKGROUP_SIZE);
}
