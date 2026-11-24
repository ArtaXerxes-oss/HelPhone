/**
 * Mapbox custom layer that draws straight from preallocated typed arrays
 * (ADR-014 follow-up 3). No per-object JS allocation happens in `render` or
 * during frame ingest; popups/details use the JSON path via `buffers.get()`.
 */

import type { CustomLayerInterface } from 'mapbox-gl'
import type { TelemetryBuffers } from './telemetryBuffers.ts'

const VERTEX_SHADER = `
attribute vec2 a_pos;
attribute float a_status;
uniform mat4 u_matrix;
varying float v_status;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
  gl_PointSize = 7.0;
  v_status = a_status;
}
`

const FRAGMENT_SHADER = `
precision mediump float;
varying float v_status;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  if (dot(d, d) > 0.25) discard;
  vec3 teal = vec3(0.137, 0.294, 0.306);
  vec3 coral = vec3(1.0, 0.478, 0.42);
  vec3 purple = vec3(0.451, 0.341, 1.0);
  vec3 color = v_status < 0.5 ? teal : (v_status < 1.5 ? purple : coral);
  gl_FragColor = vec4(color, 0.95);
}
`

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('could not create telemetry shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`telemetry shader compile failed: ${info}`)
  }
  return shader
}

/** Shader sources exported for the conformance/benchmark harness. */
export const TELEMETRY_SHADERS = Object.freeze({ vertex: VERTEX_SHADER, fragment: FRAGMENT_SHADER })

export function createTelemetryLayer(buffers: TelemetryBuffers, id = 'helphone-telemetry'): CustomLayerInterface {
  let program: WebGLProgram | null = null
  let positionBuffer: WebGLBuffer | null = null
  let statusBuffer: WebGLBuffer | null = null
  let statusValues: Float32Array | null = null
  let locPos = -1
  let locStatus = -1
  let locMatrix = -1
  let uploadedGeneration = -1

  return {
    id,
    type: 'custom',
    renderingMode: '2d',

    onAdd(_map, gl: WebGLRenderingContext) {
      const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
      program = gl.createProgram()
      if (!program) throw new Error('could not create telemetry program')
      gl.attachShader(program, vs)
      gl.attachShader(program, fs)
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`telemetry program link failed: ${gl.getProgramInfoLog(program)}`)
      }
      gl.deleteShader(vs)
      gl.deleteShader(fs)

      positionBuffer = gl.createBuffer()
      statusBuffer = gl.createBuffer()
      statusValues = new Float32Array(buffers.capacity)
      locPos = gl.getAttribLocation(program, 'a_pos')
      locStatus = gl.getAttribLocation(program, 'a_status')
      locMatrix = gl.getUniformLocation(program, 'u_matrix') as unknown as number
    },

    onRemove(_map, gl: WebGLRenderingContext) {
      if (positionBuffer) gl.deleteBuffer(positionBuffer)
      if (statusBuffer) gl.deleteBuffer(statusBuffer)
      if (program) gl.deleteProgram(program)
      program = null
      positionBuffer = null
      statusBuffer = null
      statusValues = null
      uploadedGeneration = -1
    },

    render(gl: WebGLRenderingContext, matrix: number[]) {
      if (!program || !positionBuffer || !statusBuffer || !statusValues) return
      if (uploadedGeneration !== buffers.generation) {
        // Upload only the valid portion; no copy of the source arrays.
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, buffers.positions(), gl.DYNAMIC_DRAW)
        for (let i = 0; i < buffers.count; i++) statusValues[i] = buffers.statuses[i]
        gl.bindBuffer(gl.ARRAY_BUFFER, statusBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, statusValues.subarray(0, buffers.count), gl.DYNAMIC_DRAW)
        uploadedGeneration = buffers.generation
      }
      if (!buffers.count) return

      gl.useProgram(program)
      gl.uniformMatrix4fv(locMatrix as unknown as WebGLUniformLocation, false, matrix)

      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
      gl.enableVertexAttribArray(locPos)
      gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 0, 0)

      gl.bindBuffer(gl.ARRAY_BUFFER, statusBuffer)
      gl.enableVertexAttribArray(locStatus)
      gl.vertexAttribPointer(locStatus, 1, gl.FLOAT, false, 0, 0)

      gl.drawArrays(gl.POINTS, 0, buffers.count)
    },
  }
}
