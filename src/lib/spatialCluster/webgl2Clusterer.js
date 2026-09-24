// WebGL 2.0 fallback for the grid-clustering spike (issue #608, ADR-008).
//
// WebGL2 has no compute shaders or storage atomics, so the grid stage is done
// with the classic "scatter by rasterisation" trick: each point is drawn as a
// 1px GL_POINT into the texel of its grid cell of an RGBA32F render target.
//
//   pass 1 (additive blending): texel += (1, localX, localY, 0)
//   pass 2 (MAX blending):      texel  = max(texel, distance to cell centroid)
//
// Needs EXT_color_buffer_float (render to float) and EXT_float_blend (blend
// float targets). Sums are f32, so they are exact only up to 2^24 — plenty for
// counts, approximate for offset sums in very hot cells (see ADR-008).

import { cellTotal } from "./gridParams.js";

const BIN_VS = `#version 300 es
in vec2 a_pos;
uniform vec2 u_origin;
uniform float u_cellSize;
uniform ivec2 u_grid;
out vec2 v_local;
void main() {
  vec2 g = floor((a_pos - u_origin) / u_cellSize);
  gl_PointSize = 1.0;
  if (g.x < 0.0 || g.y < 0.0 || g.x >= float(u_grid.x) || g.y >= float(u_grid.y)) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0); // clipped
    v_local = vec2(0.0);
    return;
  }
  v_local = a_pos - (u_origin + g * u_cellSize);
  gl_Position = vec4((g + 0.5) / vec2(u_grid) * 2.0 - 1.0, 0.0, 1.0);
}`;

const BIN_FS = `#version 300 es
precision highp float;
in vec2 v_local;
out vec4 o;
void main() { o = vec4(1.0, v_local, 0.0); }`;

const SPREAD_VS = `#version 300 es
in vec2 a_pos;
uniform vec2 u_origin;
uniform float u_cellSize;
uniform ivec2 u_grid;
uniform highp sampler2D u_bins;
out float v_dist;
void main() {
  vec2 g = floor((a_pos - u_origin) / u_cellSize);
  gl_PointSize = 1.0;
  if (g.x < 0.0 || g.y < 0.0 || g.x >= float(u_grid.x) || g.y >= float(u_grid.y)) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    v_dist = 0.0;
    return;
  }
  vec4 bin = texelFetch(u_bins, ivec2(g), 0);
  // (\`centroid\` is a reserved word in GLSL ES 3.00.)
  vec2 cellCentroid = bin.yz / bin.x;
  v_dist = distance(a_pos - (u_origin + g * u_cellSize), cellCentroid);
  gl_Position = vec4((g + 0.5) / vec2(u_grid) * 2.0 - 1.0, 0.0, 1.0);
}`;

const SPREAD_FS = `#version 300 es
precision highp float;
in float v_dist;
out vec4 o;
void main() { o = vec4(v_dist, 0.0, 0.0, 0.0); }`;

function getContext(canvas) {
  const gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false });
  if (!gl) return null;
  if (!gl.getExtension("EXT_color_buffer_float") || !gl.getExtension("EXT_float_blend")) return null;
  return gl;
}

function makeCanvas() {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(1, 1);
  if (typeof document !== "undefined") return document.createElement("canvas");
  return null;
}

export function isWebGL2Available() {
  const canvas = makeCanvas();
  return Boolean(canvas && getContext(canvas));
}

function compile(gl, vsSrc, fsSrc) {
  const program = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vsSrc],
    [gl.FRAGMENT_SHADER, fsSrc],
  ]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`GLSL compile failed: ${gl.getShaderInfoLog(shader)}`);
    }
    gl.attachShader(program, shader);
  }
  gl.bindAttribLocation(program, 0, "a_pos");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`GLSL link failed: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

export function createWebGL2Clusterer(params) {
  const canvas = makeCanvas();
  const gl = canvas && getContext(canvas);
  if (!gl) throw new Error("WebGL2 with EXT_color_buffer_float + EXT_float_blend unavailable");

  const { gridW, gridH, fixedScale } = params;
  const cells = cellTotal(params);

  const binProgram = compile(gl, BIN_VS, BIN_FS);
  const spreadProgram = compile(gl, SPREAD_VS, SPREAD_FS);

  const makeTarget = () => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, gridW, gridH);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("RGBA32F framebuffer incomplete");
    }
    return { tex, fbo };
  };
  const bins = makeTarget();
  const spread = makeTarget();

  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const setCommonUniforms = (program) => {
    gl.useProgram(program);
    gl.uniform2f(gl.getUniformLocation(program, "u_origin"), params.originX, params.originY);
    gl.uniform1f(gl.getUniformLocation(program, "u_cellSize"), params.cellSize);
    gl.uniform2i(gl.getUniformLocation(program, "u_grid"), gridW, gridH);
  };

  const binPixels = new Float32Array(cells * 4);
  const spreadPixels = new Float32Array(cells * 4);
  let vboBytes = 0;

  async function cluster(points) {
    const n = points.length >> 1;
    const t0 = performance.now();

    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    if (points.byteLength > vboBytes) {
      gl.bufferData(gl.ARRAY_BUFFER, points, gl.DYNAMIC_DRAW);
      vboBytes = points.byteLength;
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, points);
    }
    const tUploaded = performance.now();

    gl.viewport(0, 0, gridW, gridH);
    gl.enable(gl.BLEND);
    gl.bindVertexArray(vao);

    gl.bindFramebuffer(gl.FRAMEBUFFER, bins.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    setCommonUniforms(binProgram);
    gl.drawArrays(gl.POINTS, 0, n);

    gl.bindFramebuffer(gl.FRAMEBUFFER, spread.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendEquation(gl.MAX);
    setCommonUniforms(spreadProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bins.tex);
    gl.uniform1i(gl.getUniformLocation(spreadProgram, "u_bins"), 0);
    gl.drawArrays(gl.POINTS, 0, n);
    const tDrawn = performance.now();

    // readPixels is synchronous: it also absorbs the GPU wait.
    gl.bindFramebuffer(gl.FRAMEBUFFER, bins.fbo);
    gl.readPixels(0, 0, gridW, gridH, gl.RGBA, gl.FLOAT, binPixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, spread.fbo);
    gl.readPixels(0, 0, gridW, gridH, gl.RGBA, gl.FLOAT, spreadPixels);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const tRead = performance.now();

    // Convert to the same fixed-point grid layout the WebGPU path returns.
    const cellCount = new Uint32Array(cells);
    const cellSum = new Uint32Array(cells * 2);
    const cellRadius = new Uint32Array(cells);
    for (let c = 0; c < cells; c++) {
      cellCount[c] = Math.round(binPixels[c * 4]);
      cellSum[c * 2] = Math.round(binPixels[c * 4 + 1] * fixedScale);
      cellSum[c * 2 + 1] = Math.round(binPixels[c * 4 + 2] * fixedScale);
      cellRadius[c] = Math.round(spreadPixels[c * 4] * fixedScale);
    }
    const tDone = performance.now();

    return {
      grid: { cellCount, cellSum, cellRadius },
      timings: {
        encodeMs: tUploaded - t0,
        gpuRoundTripMs: tRead - tUploaded,
        gpuPassMs: null,
        readbackMs: tDone - tRead,
        drawSubmitMs: tDrawn - tUploaded,
        totalMs: tDone - t0,
        uploadBytes: n * 8,
        readbackBytes: cells * 32,
      },
    };
  }

  return {
    backend: "webgl2",
    cluster,
    get memoryBytes() {
      return vboBytes + cells * 16 * 2;
    },
    destroy() {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
