/**
 * FlatBuffers accessors for `telemetry.fbs`.
 *
 * This file is the checked-in JS equivalent of `flatc --js` output. It is kept
 * in source control so the in-repo reader works without a native compiler;
 * `telemetry.fbs` remains the canonical schema and is what `flatc` validates
 * against. Field numbers below map 1:1 to the declaration order in the schema,
 * and the vtable slots are `4 + 2 * fieldNumber` exactly as flatc emits.
 *
 * Automatically generated shape — do not hand-edit field ordering.
 */

import { ByteBuffer } from "flatbuffers";

/** File identifier from the schema (4 bytes, written by Builder.finish). */
export const FILE_IDENTIFIER = "HPTL";
/** Hard cap on objects per frame. Encoder throws RangeError above this. */
export const MAX_OBJECTS_PER_FRAME = 1000;
/** Bumped when the wire layout changes incompatibly. */
export const SCHEMA_VERSION = 1;

/** `Kind` enum from the schema. */
export const Kind = Object.freeze({ Responder: 0, Requester: 1, Incident: 2 });
/** `Status` enum from the schema. */
export const Status = Object.freeze({
  Active: 0,
  EnRoute: 1,
  OnScene: 2,
  Resolved: 3,
});

function asByteBuffer(input) {
  return input instanceof ByteBuffer
    ? input
    : new ByteBuffer(
        input instanceof Uint8Array
          ? input
          : new Uint8Array(
              input.buffer || input,
              input.byteOffset || 0,
              input.byteLength,
            ),
      );
}

/** Read a uoffset at `pos` and return the absolute target position. */
function indirect(bb, pos) {
  return pos + bb.readInt32(pos);
}

/** Byte position of field `fieldNumber` of the table at `pos`, or 0 if absent. */
function fieldPos(bb, pos, fieldNumber) {
  const vtable = pos - bb.readInt32(pos);
  const slot = 4 + 2 * fieldNumber;
  const offset = slot < bb.readInt16(vtable) ? bb.readInt16(vtable + slot) : 0;
  return offset ? pos + offset : 0;
}

// ---------------------------------------------------------------------------
// TrackedObject
// ---------------------------------------------------------------------------

export class TrackedObject {
  constructor(bb = null, pos = 0) {
    this.bb = bb;
    this.pos = pos;
  }

  /** Bind this instance to an existing table position (flatc `__init`). */
  init(bb, pos) {
    this.bb = bb;
    this.pos = pos;
    return this;
  }

  id() {
    const p = fieldPos(this.bb, this.pos, 0);
    return p ? this.bb.readUint32(p) : 0;
  }

  kind() {
    const p = fieldPos(this.bb, this.pos, 1);
    return p ? this.bb.readInt8(p) : 0;
  }

  status() {
    const p = fieldPos(this.bb, this.pos, 2);
    return p ? this.bb.readInt8(p) : 0;
  }

  lat() {
    const p = fieldPos(this.bb, this.pos, 3);
    return p ? this.bb.readFloat64(p) : 0;
  }

  lng() {
    const p = fieldPos(this.bb, this.pos, 4);
    return p ? this.bb.readFloat64(p) : 0;
  }

  heading() {
    const p = fieldPos(this.bb, this.pos, 5);
    return p ? this.bb.readFloat32(p) : 0;
  }

  speed() {
    const p = fieldPos(this.bb, this.pos, 6);
    return p ? this.bb.readFloat32(p) : 0;
  }

  /** Plain-object projection for the JSON popup/details path. */
  toJSON() {
    return {
      id: this.id(),
      kind: this.kind(),
      status: this.status(),
      lat: this.lat(),
      lng: this.lng(),
      heading: this.heading(),
      speed: this.speed(),
    };
  }

  static start(builder) {
    builder.startObject(7);
  }

  // Builder.addFieldXxx takes the field index; the accessors above use the
  // vtable byte slot 4 + 2 * fieldIndex. Keep these in schema declaration order.
  static addId(builder, value) {
    builder.addFieldInt32(0, value, 0);
  }

  static addKind(builder, value) {
    builder.addFieldInt8(1, value, 0);
  }

  static addStatus(builder, value) {
    builder.addFieldInt8(2, value, 0);
  }

  static addLat(builder, value) {
    builder.addFieldFloat64(3, value, 0);
  }

  static addLng(builder, value) {
    builder.addFieldFloat64(4, value, 0);
  }

  static addHeading(builder, value) {
    builder.addFieldFloat32(5, value, 0);
  }

  static addSpeed(builder, value) {
    builder.addFieldFloat32(6, value, 0);
  }

  static end(builder) {
    return builder.endObject();
  }

  static create(builder, obj = {}) {
    TrackedObject.start(builder);
    if (obj.id) TrackedObject.addId(builder, obj.id);
    if (obj.kind) TrackedObject.addKind(builder, obj.kind);
    if (obj.status) TrackedObject.addStatus(builder, obj.status);
    if (obj.lat) TrackedObject.addLat(builder, obj.lat);
    if (obj.lng) TrackedObject.addLng(builder, obj.lng);
    if (obj.heading) TrackedObject.addHeading(builder, obj.heading);
    if (obj.speed) TrackedObject.addSpeed(builder, obj.speed);
    return TrackedObject.end(builder);
  }
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

export class Frame {
  constructor(bb = null, pos = 0) {
    this.bb = bb;
    this.pos = pos;
  }

  init(bb, pos) {
    this.bb = bb;
    this.pos = pos;
    return this;
  }

  objectsLength() {
    const p = fieldPos(this.bb, this.pos, 0);
    if (!p) return 0;
    const vec = indirect(this.bb, p);
    return this.bb.readInt32(vec);
  }

  objects(index) {
    const p = fieldPos(this.bb, this.pos, 0);
    if (!p) return null;
    const vec = indirect(this.bb, p);
    if (index < 0 || index >= this.bb.readInt32(vec)) return null;
    const elem = vec + 4 + index * 4;
    return new TrackedObject(this.bb, indirect(this.bb, elem));
  }

  tsSec() {
    const p = fieldPos(this.bb, this.pos, 1);
    return p ? this.bb.readUint32(p) : 0;
  }

  seq() {
    const p = fieldPos(this.bb, this.pos, 2);
    return p ? this.bb.readUint32(p) : 0;
  }

  version() {
    const p = fieldPos(this.bb, this.pos, 3);
    return p ? this.bb.readUint16(p) : 0;
  }

  /** Iterate objects without materialising an array of JS objects. */
  *iterateObjects() {
    const count = this.objectsLength();
    for (let i = 0; i < count; i++) yield this.objects(i);
  }

  static start(builder) {
    builder.startObject(4);
  }

  static addObjects(builder, value) {
    builder.addFieldOffset(0, value, 0);
  }

  static addTsSec(builder, value) {
    builder.addFieldInt32(1, value, 0);
  }

  static addSeq(builder, value) {
    builder.addFieldInt32(2, value, 0);
  }

  static addVersion(builder, value) {
    builder.addFieldInt16(3, value, 0);
  }

  static end(builder) {
    return builder.endObject();
  }

  static createObjectsVector(builder, offsets) {
    builder.startVector(4, offsets.length, 4);
    for (let i = offsets.length - 1; i >= 0; i--) builder.addOffset(offsets[i]);
    return builder.endVector();
  }

  static create(
    builder,
    { objects = [], tsSec = 0, seq = 0, version = SCHEMA_VERSION } = {},
  ) {
    const vec = objects.length
      ? Frame.createObjectsVector(builder, objects)
      : 0;
    Frame.start(builder);
    if (vec) Frame.addObjects(builder, vec);
    if (tsSec) Frame.addTsSec(builder, tsSec);
    if (seq) Frame.addSeq(builder, seq);
    if (version) Frame.addVersion(builder, version);
    return Frame.end(builder);
  }

  static finish(builder, offset) {
    builder.finish(offset, FILE_IDENTIFIER);
  }
}

/** Point `obj` at the root Frame of `input` (a Uint8Array/ArrayBuffer/ByteBuffer). */
export function getRootAsFrame(input, obj = new Frame()) {
  const bb = asByteBuffer(input);
  const rootPos = bb.position() + bb.readInt32(bb.position());
  return obj.init(bb, rootPos);
}

/** True when the buffer carries the HPTL file identifier. */
export function hasFileIdentifier(input) {
  try {
    return asByteBuffer(input).__has_identifier(FILE_IDENTIFIER);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Zero-allocation accessors used by the map's typed-array ingest path. These
// return raw positions; no TrackedObject instance is created per record.
// ---------------------------------------------------------------------------

/** Bind a frame buffer and return `{ bb, pos }` for its root table. */
export function frameRootPosition(input) {
  const bb = asByteBuffer(input);
  return { bb, pos: bb.position() + bb.readInt32(bb.position()) };
}

/** Return `{ vec, count }` for the frame's `objects` vector (or 0,0). */
export function objectsVector(bb, framePos) {
  const p = fieldPos(bb, framePos, 0);
  if (!p) return { vec: 0, count: 0 };
  const vec = indirect(bb, p);
  return { vec, count: bb.readInt32(vec) };
}

/** Absolute table position of object `index` in a valid objects vector. */
export function objectAt(bb, vec, index) {
  const elem = vec + 4 + index * 4;
  return indirect(bb, elem);
}

/** Byte position of a scalar field, or 0 when absent. */
export function scalarFieldPosition(bb, pos, fieldIndex) {
  return fieldPos(bb, pos, fieldIndex);
}
