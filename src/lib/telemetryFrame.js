/**
 * HelPhone telemetry frame codec (ADR-014 follow-up 2).
 *
 * Encoding uses the official `flatbuffers` Builder; decoding uses the checked-in
 * accessors generated from `src/schemas/telemetry.fbs`. The wire layout is
 * therefore decodable by `flatc --json --strict-json` as well as by this
 * reader. Ingest uses `verifyFrame`, which returns a result instead of throwing
 * so a malformed frame can be dropped without taking down the main path.
 */

import { Builder } from "flatbuffers";
import {
  FILE_IDENTIFIER,
  Frame,
  MAX_OBJECTS_PER_FRAME,
  SCHEMA_VERSION,
  getRootAsFrame,
  hasFileIdentifier,
} from "../schemas/telemetry_generated.js";

export {
  FILE_IDENTIFIER,
  Frame,
  Kind,
  MAX_OBJECTS_PER_FRAME,
  SCHEMA_VERSION,
  Status,
  TrackedObject,
  getRootAsFrame,
} from "../schemas/telemetry_generated.js";

/** Default ceiling for a single binary frame (1 MiB). */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Raised when a frame would exceed the object cap. Callers treat it as a drop. */
export class TelemetryFrameRangeError extends RangeError {
  constructor(count) {
    super(
      `telemetry frame exceeds ${MAX_OBJECTS_PER_FRAME} objects (got ${count})`,
    );
    this.name = "TelemetryFrameRangeError";
    this.count = count;
  }
}

const isByte = (v) => Number.isInteger(v) && v >= -128 && v <= 127;
const finite = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Encode objects into one FlatBuffers frame.
 *
 * @param {Array<object>} objects at most MAX_OBJECTS_PER_FRAME records
 * @param {{tsSec?: number, seq?: number, version?: number}} [meta]
 * @returns {Uint8Array} a complete buffer carrying the `HPTL` identifier
 */
export function encodeTelemetryFrame(objects, meta = {}) {
  if (!Array.isArray(objects))
    throw new TypeError("telemetry objects must be an array");
  if (objects.length > MAX_OBJECTS_PER_FRAME)
    throw new TelemetryFrameRangeError(objects.length);

  const {
    tsSec = Math.floor(Date.now() / 1000),
    seq = 0,
    version = SCHEMA_VERSION,
  } = meta;
  if (!Number.isInteger(tsSec) || tsSec < 0)
    throw new TypeError("tsSec must be a non-negative integer");
  if (!Number.isInteger(seq) || seq < 0)
    throw new TypeError("seq must be a non-negative integer");

  const builder = new Builder(1024 + objects.length * 32);
  const offsets = [];
  for (const object of objects) {
    if (!object || typeof object !== "object")
      throw new TypeError("invalid telemetry object");
    const id = Number(object.id) >>> 0;
    const kind = object.kind | 0;
    const status = object.status | 0;
    const lat = Number(object.lat ?? 0);
    const lng = Number(object.lng ?? 0);
    const heading = Number(object.heading ?? 0);
    const speed = Number(object.speed ?? 0);
    if (!finite(lat) || !finite(lng))
      throw new TypeError("telemetry lat/lng must be finite");
    if (!finite(heading) || !finite(speed))
      throw new TypeError("telemetry heading/speed must be finite");
    if (!isByte(kind) || !isByte(status))
      throw new TypeError("telemetry kind/status must be bytes");

    // Inline construction avoids per-object helper allocation on the server.
    builder.startObject(7);
    if (id) builder.addFieldInt32(0, id, 0);
    if (kind) builder.addFieldInt8(1, kind, 0);
    if (status) builder.addFieldInt8(2, status, 0);
    if (lat) builder.addFieldFloat64(3, lat, 0);
    if (lng) builder.addFieldFloat64(4, lng, 0);
    if (heading) builder.addFieldFloat32(5, heading, 0);
    if (speed) builder.addFieldFloat32(6, speed, 0);
    offsets.push(builder.endObject());
  }

  const vector = offsets.length
    ? Frame.createObjectsVector(builder, offsets)
    : 0;
  builder.startObject(4);
  if (vector) builder.addFieldOffset(0, vector, 0);
  if (tsSec) builder.addFieldInt32(1, tsSec, 0);
  if (seq) builder.addFieldInt32(2, seq, 0);
  if (version) builder.addFieldInt16(3, version, 0);
  const root = builder.endObject();
  Frame.finish(builder, root);
  return builder.asUint8Array();
}

function failure(error) {
  return { ok: false, error };
}

/**
 * Walk the raw vtable/table structure with explicit bounds checks.
 * ByteBuffer's scalar reads coerce out-of-range reads to 0, so a plain
 * "did it throw?" test is not enough to detect a truncated frame.
 */
function validateStructure(bb, rootPos, len) {
  const checkTable = (pos) => {
    if (!Number.isInteger(pos) || pos < 8 || pos + 4 > len) return null;
    const vtable = pos - bb.readInt32(pos);
    if (vtable < 0 || vtable + 4 > len) return null;
    const vtableSize = bb.readInt16(vtable);
    const tableSize = bb.readInt16(vtable + 2);
    if (vtableSize < 4 || vtableSize % 2 || vtable + vtableSize > len)
      return null;
    if (tableSize < 4 || pos + tableSize > len) return null;
    return { vtable, vtableSize, tableSize };
  };

  const root = checkTable(rootPos);
  if (!root) return "truncated root table";

  let objectsOffset = 0;
  if (4 < root.vtableSize) objectsOffset = bb.readInt16(root.vtable + 4);
  let count = 0;
  if (objectsOffset) {
    const uoffsetPos = rootPos + objectsOffset;
    if (uoffsetPos < 0 || uoffsetPos + 4 > len)
      return "objects field out of bounds";
    const vec = uoffsetPos + bb.readInt32(uoffsetPos);
    if (vec < 0 || vec + 4 > len) return "truncated vector header";
    count = bb.readInt32(vec);
    if (
      !Number.isInteger(count) ||
      count < 0 ||
      count > MAX_OBJECTS_PER_FRAME
    ) {
      return `invalid object count ${count}`;
    }
    if (vec + 4 + count * 4 > len) return "truncated object vector";
    for (let i = 0; i < count; i++) {
      const elem = vec + 4 + i * 4;
      const rel = bb.readInt32(elem);
      if (rel <= 0 || elem + rel + 4 > len)
        return `object ${i} offset out of bounds`;
      const childPos = elem + rel;
      const child = checkTable(childPos);
      if (!child) return `truncated object ${i}`;
      // Every scalar field must lie inside the buffer as well.
      for (let f = 0; f < 7; f++) {
        const slot = 4 + 2 * f;
        if (slot >= child.vtableSize) continue;
        const off = bb.readInt16(child.vtable + slot);
        if (!off) continue;
        const width = f === 3 || f === 4 ? 8 : f === 5 || f === 6 ? 4 : 4;
        if (childPos + off + width > len)
          return `object ${i} field ${f} out of bounds`;
      }
    }
  }
  return null;
}

/**
 * Verify a candidate frame without ever throwing on the main path.
 *
 * @returns {{ok: boolean, error?: string, frame?: Frame, objectCount?: number}}
 */
export function verifyFrame(input, { maxFrameBytes = MAX_FRAME_BYTES } = {}) {
  try {
    if (!input) return failure("empty frame");
    // Normalise across realms (a Node Buffer in jsdom is not `instanceof` the
    // test realm's Uint8Array) by copying into a local view when needed.
    let bytes = null;
    if (input instanceof Uint8Array) bytes = input;
    else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else if (input && typeof input.byteLength === "number" && input.buffer) {
      const start = input.byteOffset || 0;
      bytes = new Uint8Array(
        input.buffer.slice(start, start + input.byteLength),
      );
    }
    if (!bytes || bytes.byteLength < 8 + 4) return failure("frame too short");
    if (bytes.byteLength > maxFrameBytes)
      return failure("frame exceeds byte budget");
    if (!hasFileIdentifier(bytes)) return failure("bad file identifier");

    const frame = getRootAsFrame(bytes);
    const bb = frame.bb;
    const rootOffset = bb.readInt32(bb.position());
    if (rootOffset < 8 || rootOffset >= bytes.byteLength)
      return failure("invalid root offset");

    const structuralError = validateStructure(bb, rootOffset, bytes.byteLength);
    if (structuralError) return failure(structuralError);

    const version = frame.version();
    if (version !== SCHEMA_VERSION)
      return failure(`unsupported schema version ${version}`);

    const count = frame.objectsLength();
    for (let i = 0; i < count; i++) {
      const obj = frame.objects(i);
      if (!obj) return failure(`missing object ${i}`);
      if (!finite(obj.lat()) || !finite(obj.lng()))
        return failure(`non-finite coordinates at ${i}`);
      if (!finite(obj.heading()) || !finite(obj.speed()))
        return failure(`non-finite motion at ${i}`);
    }
    return {
      ok: true,
      frame,
      objectCount: count,
      byteLength: bytes.byteLength,
    };
  } catch (err) {
    return failure(
      `malformed frame: ${err && err.message ? err.message : String(err)}`,
    );
  }
}

/** Verify then decode. Throws on malformed input; use `verifyFrame` on ingest. */
export function decodeTelemetryFrame(input, options) {
  const result = verifyFrame(input, options);
  if (!result.ok) throw new Error(result.error);
  return result.frame;
}

/** Verify then project to plain objects (JSON popup/details path only). */
export function readTelemetryObjects(input, options) {
  const frame = decodeTelemetryFrame(input, options);
  const out = [];
  for (const obj of frame.iterateObjects()) out.push(obj.toJSON());
  return out;
}

/** Structural summary used by the frame-size/rate budget reporter. */
export function frameSummary(input, options) {
  const result = verifyFrame(input, options);
  if (!result.ok) return result;
  return {
    ok: true,
    byteLength: result.byteLength,
    objectCount: result.objectCount,
    seq: result.frame.seq(),
    tsSec: result.frame.tsSec(),
    version: result.frame.version(),
    identifier: FILE_IDENTIFIER,
  };
}
