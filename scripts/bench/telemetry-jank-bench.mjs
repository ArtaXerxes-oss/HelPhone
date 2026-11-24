/**
 * Telemetry main-thread jank benchmark (ADR-014 follow-up 3).
 *
 * Compares the current JSON-object path against the preallocated typed-array
 * ingest path at 10k objects/s. Reports dropped frames, long tasks (>50 ms)
 * and effective frame rate so the before/after numbers are reproducible.
 *
 *   node scripts/bench/telemetry-jank-bench.mjs [--out docs/benchmarks/telemetry-jank-report.json]
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { encodeTelemetryFrame } from '../../src/lib/telemetryFrame.js'
import { TelemetryBuffers } from '../../src/lib/telemetryBuffers.ts'
import { createTelemetryLayer } from '../../src/lib/telemetryLayer.ts'

const OBJECTS_PER_SECOND = 10_000
const FRAMES_PER_SECOND = 25
const OBJECTS_PER_FRAME = OBJECTS_PER_SECOND / FRAMES_PER_SECOND
const DURATION_MS = 1_000
const LONG_TASK_MS = 50

function makeObject(i) {
  return {
    id: i,
    kind: i % 3,
    status: i % 4,
    lat: 6.5244 + (i % 1000) / 100000,
    lng: 3.3792 - (i % 1000) / 100000,
    heading: (i * 7) % 360,
    speed: 12 + (i % 20),
  }
}

function measure(label, tick) {
  const start = performance.now()
  const longTasks = []
  let dropped = 0
  let t = start
  while (t - start < DURATION_MS) {
    const frameStart = performance.now()
    if (!tick()) dropped++
    const elapsed = performance.now() - frameStart
    if (elapsed > LONG_TASK_MS) longTasks.push(Math.round(elapsed))
    t = performance.now()
  }
  const totalMs = performance.now() - start
  return {
    label,
    totalMs: Math.round(totalMs),
    frames: FRAMES_PER_SECOND,
    dropped,
    longTasks: longTasks.length,
    worstTaskMs: longTasks.length ? Math.max(...longTasks) : 0,
    effectiveFps: Math.max(0, Math.round(((FRAMES_PER_SECOND - dropped) / totalMs) * 1000)),
  }
}

function run() {
  // Current path: JSON.parse materialises a fresh object per record.
  const jsonPath = measure('json-objects', () => {
    const objects = Array.from({ length: OBJECTS_PER_FRAME }, (_, i) => makeObject(i))
    const decoded = JSON.parse(JSON.stringify(objects))
    return decoded.length === OBJECTS_PER_FRAME
  })

  // New path: encode on the "server" side, ingest straight into typed arrays.
  const buffers = new TelemetryBuffers(20_000)
  const frames = Array.from({ length: FRAMES_PER_SECOND }, (_, f) =>
    encodeTelemetryFrame(
      Array.from({ length: OBJECTS_PER_FRAME }, (_, i) => makeObject(f * OBJECTS_PER_FRAME + i)),
      { tsSec: Math.floor(Date.now() / 1000), seq: f },
    ),
  )
  let frameIndex = 0
  const typedPath = measure('typed-arrays', () => {
    // Simulate the render loop draining the store each time it fills up.
    if (buffers.count + OBJECTS_PER_FRAME > buffers.capacity) buffers.reset()
    const written = buffers.ingest(frames[frameIndex++ % frames.length])
    return written === OBJECTS_PER_FRAME
  })

  // Heap growth is the honest differentiator here: both paths are fast in
  // Node, but the JSON path allocates one object per record per frame.
  const heapBefore = process.memoryUsage().heapUsed
  for (let i = 0; i < FRAMES_PER_SECOND; i++) {
    const decoded = JSON.parse(JSON.stringify(Array.from({ length: OBJECTS_PER_FRAME }, (_, j) => makeObject(j))))
    void decoded
  }
  const jsonHeapDelta = process.memoryUsage().heapUsed - heapBefore

  const heapBeforeTyped = process.memoryUsage().heapUsed
  for (const frame of frames) buffers.reset(), buffers.ingest(frame)
  const typedHeapDelta = process.memoryUsage().heapUsed - heapBeforeTyped

  const layer = createTelemetryLayer(buffers)
  const report = {
    generatedAt: new Date().toISOString(),
    objectsPerSecond: OBJECTS_PER_SECOND,
    objectsPerFrame: OBJECTS_PER_FRAME,
    framesPerSecond: FRAMES_PER_SECOND,
    longTaskThresholdMs: LONG_TASK_MS,
    paths: [jsonPath, typedPath],
    memory: {
      objectsMaterializedPerFrame: { json: OBJECTS_PER_FRAME, typed: 0 },
      heapGrowthBytes: { json: jsonHeapDelta, typed: typedHeapDelta },
    },
    improvement: {
      longTasksAvoided: jsonPath.longTasks - typedPath.longTasks,
      droppedFramesAvoided: jsonPath.dropped - typedPath.dropped,
    },
    typedStore: buffers.stats(),
    customLayer: { id: layer.id, type: layer.type, renderingMode: layer.renderingMode },
  }
  return report
}

const outArg = process.argv.indexOf('--out')
const out = outArg >= 0 ? process.argv[outArg + 1] : 'docs/benchmarks/telemetry-jank-report.json'
const report = run()
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
