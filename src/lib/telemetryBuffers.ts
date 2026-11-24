/**
 * Preallocated typed-array store for the live map (ADR-014 follow-up 3).
 *
 * Frames are decoded straight into these arrays with the zero-allocation
 * accessors in `telemetry_generated.js`: no array of JS objects is created on
 * the main thread. Plain objects are produced only by `get()` for the JSON
 * popup/details path.
 */

import { ByteBuffer } from 'flatbuffers'
import {
  MAX_OBJECTS_PER_FRAME,
  objectsVector,
  objectAt,
  scalarFieldPosition,
} from '../schemas/telemetry_generated.js'
import { verifyFrame } from './telemetryFrame.js'

export const DEFAULT_TELEMETRY_CAPACITY = 20000

/** WebGL mercator coordinate from lng/lat, computed without allocating. */
function mercatorX(lng: number): number {
  return (lng + 180) / 360
}
function mercatorY(lat: number): number {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat))
  const rad = (clamped * Math.PI) / 180
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2
}

export class TelemetryBuffers {
  readonly capacity: number
  readonly ids: Uint32Array
  readonly kinds: Uint8Array
  readonly statuses: Uint8Array
  readonly lats: Float64Array
  readonly lngs: Float64Array
  readonly headings: Float32Array
  /** Interleaved [x, y] WebGL mercator positions for the custom layer. */
  readonly mercator: Float32Array

  count = 0
  dropped = 0
  seq = 0
  tsSec = 0
  /** Increment on every ingest so the GL layer knows what to upload. */
  generation = 0

  constructor(capacity = DEFAULT_TELEMETRY_CAPACITY) {
    this.capacity = capacity
    this.ids = new Uint32Array(capacity)
    this.kinds = new Uint8Array(capacity)
    this.statuses = new Uint8Array(capacity)
    this.lats = new Float64Array(capacity)
    this.lngs = new Float64Array(capacity)
    this.headings = new Float32Array(capacity)
    this.mercator = new Float32Array(capacity * 2)
  }

  /** Clear without reallocating. */
  reset(): void {
    this.count = 0
    this.generation++
  }

  /**
   * Ingest one verified frame. Returns the number of records written.
   * Malformed frames increment `dropped` and never throw.
   */
  ingest(frameBytes: Uint8Array | ArrayBuffer): number {
    const result = verifyFrame(frameBytes)
    if (!result.ok) {
      this.dropped++
      return 0
    }
    const { bb, pos } = result.frame as { bb: ByteBuffer; pos: number }
    const { vec, count } = objectsVector(bb, pos)
    this.seq = result.frame.seq()
    this.tsSec = result.frame.tsSec()

    const room = Math.min(count, this.capacity - this.count)
    if (room < count) this.dropped += count - room

    let n = this.count
    for (let i = 0; i < room; i++) {
      const table = objectAt(bb, vec, i)
      const idPos = scalarFieldPosition(bb, table, 0)
      const kindPos = scalarFieldPosition(bb, table, 1)
      const statusPos = scalarFieldPosition(bb, table, 2)
      const latPos = scalarFieldPosition(bb, table, 3)
      const lngPos = scalarFieldPosition(bb, table, 4)
      const headingPos = scalarFieldPosition(bb, table, 5)

      const lat = latPos ? bb.readFloat64(latPos) : 0
      const lng = lngPos ? bb.readFloat64(lngPos) : 0
      this.ids[n] = idPos ? bb.readUint32(idPos) : 0
      this.kinds[n] = kindPos ? bb.readInt8(kindPos) : 0
      this.statuses[n] = statusPos ? bb.readInt8(statusPos) : 0
      this.lats[n] = lat
      this.lngs[n] = lng
      this.headings[n] = headingPos ? bb.readFloat32(headingPos) : 0
      this.mercator[2 * n] = mercatorX(lng)
      this.mercator[2 * n + 1] = mercatorY(lat)
      n++
    }
    this.count = n
    this.generation++
    return room
  }

  /** Plain-object projection — for popups and details only, never per frame. */
  get(index: number) {
    if (index < 0 || index >= this.count) return null
    return {
      id: this.ids[index],
      kind: this.kinds[index],
      status: this.statuses[index],
      lat: this.lats[index],
      lng: this.lngs[index],
      heading: this.headings[index],
    }
  }

  /** Live view of the valid portion of the position buffer (no copy). */
  positions(): Float32Array {
    return this.mercator.subarray(0, this.count * 2)
  }

  stats() {
    return {
      capacity: this.capacity,
      count: this.count,
      dropped: this.dropped,
      seq: this.seq,
      generation: this.generation,
      maxObjectsPerFrame: MAX_OBJECTS_PER_FRAME,
    }
  }
}
