// Grid-DBSCAN spatial clustering — compute stage (issue #608, ADR-008).
//
// Two entry points run back-to-back in one compute pass:
//
//   assignCells   — bucket every point into a uniform grid cell and accumulate
//                   per-cell count + fixed-point sum of in-cell offsets.
//   measureSpread — distance from every point to its cell centroid, reduced
//                   with atomicMax into a per-cell radius.
//
// The CPU merges adjacent dense cells into clusters afterwards (a few thousand
// cells, not 50k points), see src/lib/spatialCluster/mergeCells.js.
//
// WGSL has no float atomics, so offsets are quantised to u32 fixed point.
// Offsets are relative to the cell origin (bounded by cellSize), which keeps
// the per-cell sums well inside u32 range; createGridParams() picks a
// fixedScale that cannot overflow for the configured point capacity.
//
// Keep WORKGROUP_SIZE, OUTSIDE and the Params layout in sync with
// src/lib/spatialCluster/gridParams.js.

const WORKGROUP_SIZE: u32 = 256u;
const OUTSIDE: u32 = 0xffffffffu;

struct Params {
  origin: vec2<f32>,
  cellSize: f32,
  fixedScale: f32,
  gridW: u32,
  gridH: u32,
  pointCount: u32,
  _pad: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> points: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> pointCell: array<u32>;
@group(0) @binding(3) var<storage, read_write> cellCount: array<atomic<u32>>;
// Interleaved [sumX, sumY] per cell.
@group(0) @binding(4) var<storage, read_write> cellSum: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> cellRadius: array<atomic<u32>>;

fn cellOf(p: vec2<f32>) -> u32 {
  let g = floor((p - params.origin) / params.cellSize);
  if (g.x < 0.0 || g.y < 0.0 || g.x >= f32(params.gridW) || g.y >= f32(params.gridH)) {
    return OUTSIDE;
  }
  return u32(g.y) * params.gridW + u32(g.x);
}

fn localOffset(p: vec2<f32>, cell: u32) -> vec2<f32> {
  let cx = f32(cell % params.gridW);
  let cy = f32(cell / params.gridW);
  return p - (params.origin + vec2<f32>(cx, cy) * params.cellSize);
}

fn quantize(v: f32) -> u32 {
  return u32(clamp(round(v * params.fixedScale), 0.0, params.cellSize * params.fixedScale));
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn assignCells(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.pointCount) {
    return;
  }
  let p = points[i];
  let cell = cellOf(p);
  pointCell[i] = cell;
  if (cell == OUTSIDE) {
    return;
  }
  let off = localOffset(p, cell);
  atomicAdd(&cellCount[cell], 1u);
  atomicAdd(&cellSum[cell * 2u], quantize(off.x));
  atomicAdd(&cellSum[cell * 2u + 1u], quantize(off.y));
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn measureSpread(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.pointCount) {
    return;
  }
  let cell = pointCell[i];
  if (cell == OUTSIDE) {
    return;
  }
  let n = f32(atomicLoad(&cellCount[cell]));
  let sum = vec2<f32>(
    f32(atomicLoad(&cellSum[cell * 2u])),
    f32(atomicLoad(&cellSum[cell * 2u + 1u])),
  );
  let centroid = sum / (n * params.fixedScale);
  let d = distance(localOffset(points[i], cell), centroid);
  atomicMax(&cellRadius[cell], u32(round(d * params.fixedScale)));
}
