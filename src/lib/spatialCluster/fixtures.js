// Shared conformance fixtures for WGSL / GLSL / JS (ADR-008 decision 5 and
// follow-up 5). One fixture generator feeds every backend and the CPU oracle so
// a change to the grid contract cannot silently drift between languages.

import { binPoints } from "./cpuGridCluster.js";
import {
  OUTSIDE_CELL,
  PARAMS_BYTE_LENGTH,
  WORKGROUP_SIZE,
  createGridParams,
} from "./gridParams.js";
import { generateIncidents } from "./syntheticIncidents.js";

export const CONFORMANCE_TOLERANCE = Object.freeze({
  // f32/f64 floor() can disagree on points exactly on a cell boundary.
  maxCountMismatchCells: 2,
  maxCentroidErrPx: 0.05,
  maxRadiusErrPx: 0.05,
});

export const SHADER_CONTRACT = Object.freeze({
  workgroupSize: WORKGROUP_SIZE,
  outside: OUTSIDE_CELL,
  paramsByteLength: PARAMS_BYTE_LENGTH,
  bindings: [0, 1, 2, 3, 4, 5],
  paramsFields: ["origin", "cellSize", "fixedScale", "gridW", "gridH", "pointCount", "_pad"],
  entryPoints: ["assignCells", "measureSpread"],
});

export function checkWgslContract(source) {
  const errors = [];
  if (!source.includes(`const WORKGROUP_SIZE: u32 = ${WORKGROUP_SIZE}u;`)) errors.push("workgroup size");
  if (!source.includes(`const OUTSIDE: u32 = 0x${OUTSIDE_CELL.toString(16)}u;`)) errors.push("OUTSIDE sentinel");
  const bindings = [...source.matchAll(/@binding\((\d+)\)/g)].map((m) => Number(m[1]));
  if (JSON.stringify(bindings) !== JSON.stringify(SHADER_CONTRACT.bindings)) errors.push("bindings");
  for (const entry of SHADER_CONTRACT.entryPoints) {
    if (!source.includes(`fn ${entry}(`)) errors.push(`entry point ${entry}`);
  }
  const body = source.match(/struct Params \{([^}]*)\}/)?.[1] ?? "";
  const fields = [...body.matchAll(/(\w+):/g)].map((m) => m[1]);
  if (JSON.stringify(fields) !== JSON.stringify(SHADER_CONTRACT.paramsFields)) errors.push("Params layout");
  return { ok: errors.length === 0, errors };
}

/** The GLSL path must mirror the same bucketing + fixed-point quantisation. */
export function checkGlslContract(sources) {
  const errors = [];
  const source = Object.values(sources).join("\n");
  for (const token of ["floor(", "u_cellSize", "u_grid", "texelFetch", "gl_PointSize"]) {
    if (!source.includes(token)) errors.push(`missing ${token}`);
  }
  return { ok: errors.length === 0, errors };
}

function fixture(name, paramsInput, points) {
  const params = createGridParams(paramsInput);
  return { name, params, points, expected: binPoints(points, params) };
}

/** Small, deterministic and boundary-heavy fixtures shared by all backends. */
export function createFixtures() {
  const paramsInput = { width: 48, height: 24, cellSize: 8, maxPoints: 512 };
  const boundary = new Float32Array([
    0, 0, 7.999, 7.999, 8, 8, 15.5, 3, 24, 16, 47.9, 23.9,
    -1, 4, 48, 4, 12, -2, 12, 26,
  ]);
  const blob = generateIncidents(400, { width: 48, height: 24, seed: 608 }).points;
  return [
    fixture("boundaries-and-outliers", paramsInput, boundary),
    fixture("synthetic-hotspots", paramsInput, blob),
  ];
}

export const CLUSTER_FIXTURES = createFixtures();
