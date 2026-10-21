/**
 * Binary telemetry codecs for the live map (spike, ADR-014).
 *
 * Encoders and readers for one logical schema in four wire formats:
 *
 *   json         JSON text (the current transport), as the baseline
 *   protobuf     src/schemas/telemetry.proto (proto3, canonical encoding)
 *   flatbuffers  src/schemas/telemetry.fbs   (file identifier "HPTL")
 *   capnp        src/schemas/telemetry.capnp (unpacked; reads multi-segment)
 *
 * The readers need no dependencies. They are what `flatc --ts` and a Cap'n Proto
 * code generator emit: offset arithmetic over a DataView. They were checked
 * against flatc 2.0.8, capnp 1.0.1 and protoc 3.21 by
 * scripts/spikes/binary_conformance.js.
 *
 * Three ways to read a frame, from cheapest to most expensive:
 *
 *   readPositions(format, bytes, out)
 *     The per-frame map render path. It writes id, kind, status, lat, lng
 *     and heading into preallocated typed arrays (createPositionBuffer)
 *     and allocates nothing for flatbuffers or capnp.
 *   openFlatBuffersFrame / openCapnpFrame
 *     Zero-copy random access through reusable flyweight accessors
 *     (`frame.object(i, reuse)`), for code that needs individual fields.
 *   decodeFrame(format, bytes)
 *     Turns everything into plain JS objects. That is what JSON.parse does,
 *     and what the zero-copy formats let us skip.
 *
 * Logical object model (identical to the schemas):
 *   frame  = { seq, sentAtMs, objects: MapObject[] }
 *   object = { id, kind, status, priority, latE6, lngE6, headingCdeg,
 *              speedCms, etaSeconds, requestId, tsMs, emergencyType,
 *              responder, trail: Int32Array }
 * Missing strings decode as "" and a missing trail as an empty Int32Array,
 * the same as proto3 defaults.
 */

export const FORMATS = ["json", "protobuf", "flatbuffers", "capnp"];

export const ObjectKind = Object.freeze({ Request: 0, Responder: 1 });
export const Status = Object.freeze({ Pending: 0, Enroute: 1, Resolved: 2, Cancelled: 3 });
export const Priority = Object.freeze({ Low: 0, Medium: 1, High: 2, Critical: 3 });

/** Matches COORD_SCALE in src/lib/contract.ts. */
export const COORD_SCALE = 1_000_000;

export const FLATBUFFERS_FILE_IDENTIFIER = "HPTL";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const EMPTY_TRAIL = new Int32Array(0);

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError("expected an ArrayBuffer or ArrayBuffer view");
}

/**
 * Copies `count` little-endian int32s out of `bytes` at `pos`. When `pos` is
 * 4-byte aligned in the underlying buffer the result is a view (no copy).
 */
function int32Slice(bytes, view, pos, count) {
  if (count === 0) return EMPTY_TRAIL;
  if ((bytes.byteOffset + pos) % 4 === 0) return new Int32Array(bytes.buffer, bytes.byteOffset + pos, count);
  const out = new Int32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt32(pos + i * 4, true);
  return out;
}

// ---------------------------------------------------------------------------
// Growable little-endian writer shared by the binary encoders.

class ByteWriter {
  constructor(initialSize = 4096) {
    this.bytes = new Uint8Array(initialSize);
    this.view = new DataView(this.bytes.buffer);
    this.pos = 0;
  }

  reserve(n) {
    const need = this.pos + n;
    if (need <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.pos));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  /** Zero-pads to a multiple of `n` bytes. */
  align(n) {
    const pad = (n - (this.pos % n)) % n;
    this.reserve(pad);
    this.bytes.fill(0, this.pos, this.pos + pad);
    this.pos += pad;
  }

  skip(n) {
    this.reserve(n);
    this.bytes.fill(0, this.pos, this.pos + n);
    this.pos += n;
  }

  u8(v) { this.reserve(1); this.bytes[this.pos++] = v; }
  u16(v) { this.reserve(2); this.view.setUint16(this.pos, v, true); this.pos += 2; }
  u32(v) { this.reserve(4); this.view.setUint32(this.pos, v, true); this.pos += 4; }
  i32(v) { this.reserve(4); this.view.setInt32(this.pos, v, true); this.pos += 4; }
  f64(v) { this.reserve(8); this.view.setFloat64(this.pos, v, true); this.pos += 8; }
  raw(src) { this.reserve(src.length); this.bytes.set(src, this.pos); this.pos += src.length; }

  finish() {
    return this.bytes.slice(0, this.pos);
  }
}

// ---------------------------------------------------------------------------
// Synthetic incident stream

/** Mulberry32: small deterministic PRNG so every format sees identical data. */
export function createRng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EMERGENCY_TYPES = ["medical", "fire", "flood", "security", "accident", "other"];
const STELLAR_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function fakeStellarAddress(rng) {
  let s = "G";
  for (let i = 0; i < 55; i++) s += STELLAR_ALPHABET[(rng() * 32) | 0];
  return s;
}

/**
 * Generates `count` map objects around `center`: 30 % SOS requests and 70 %
 * responder pins, each with a trail of `trailPoints` recent positions.
 */
export function generateMapObjects(count, { seed = 1, center = [6.5244, 3.3792], spreadDeg = 0.25, trailPoints = 8, tsMs = 1_790_000_000_000 } = {}) {
  const rng = createRng(seed);
  const objects = new Array(count);
  const requestCount = Math.max(1, Math.round(count * 0.3));
  for (let i = 0; i < count; i++) {
    const isRequest = i < requestCount;
    const trail = new Int32Array(trailPoints * 2);
    let dLat = 0;
    let dLng = 0;
    for (let p = 0; p < trailPoints; p++) {
      dLat -= Math.round((rng() - 0.3) * 150);
      dLng -= Math.round((rng() - 0.3) * 150);
      trail[p * 2] = dLat;
      trail[p * 2 + 1] = dLng;
    }
    objects[i] = {
      id: i + 1,
      kind: isRequest ? ObjectKind.Request : ObjectKind.Responder,
      status: isRequest ? (rng() < 0.6 ? Status.Pending : Status.Enroute) : Status.Enroute,
      priority: (rng() * 4) | 0,
      latE6: Math.round((center[0] + (rng() - 0.5) * spreadDeg) * COORD_SCALE),
      lngE6: Math.round((center[1] + (rng() - 0.5) * spreadDeg) * COORD_SCALE),
      headingCdeg: (rng() * 36000) | 0,
      speedCms: isRequest ? 0 : (rng() * 2000) | 0,
      etaSeconds: isRequest ? 0 : 30 + ((rng() * 900) | 0),
      requestId: isRequest ? 0 : 1 + ((rng() * requestCount) | 0),
      tsMs: tsMs + ((rng() * 1000) | 0),
      emergencyType: EMERGENCY_TYPES[(rng() * EMERGENCY_TYPES.length) | 0],
      responder: isRequest ? "" : fakeStellarAddress(rng),
      trail: isRequest ? new Int32Array(0) : trail,
    };
  }
  return objects;
}

/**
 * Advances responder pins by one telemetry tick, in place. Requests stay
 * put. Used to make consecutive frames differ.
 */
export function stepMapObjects(objects, rng, dtMs = 100) {
  for (const o of objects) {
    o.tsMs += dtMs;
    if (o.kind !== ObjectKind.Responder) continue;
    const dLat = Math.round((rng() - 0.5) * 40);
    const dLng = Math.round((rng() - 0.5) * 40);
    o.latE6 += dLat;
    o.lngE6 += dLng;
    o.headingCdeg = (o.headingCdeg + ((rng() * 600) | 0) + 35700) % 36000;
    const t = o.trail;
    for (let i = t.length - 1; i >= 2; i--) t[i] = t[i - 2] - (i % 2 === 0 ? dLat : dLng);
    if (t.length >= 2) {
      t[0] = -dLat;
      t[1] = -dLng;
    }
  }
  return objects;
}

// ---------------------------------------------------------------------------
// JSON (baseline)

export function encodeJson(frame) {
  return textEncoder.encode(
    JSON.stringify(frame, (key, value) => (value instanceof Int32Array ? Array.from(value) : value)),
  );
}

export function decodeJson(bytes) {
  return JSON.parse(textDecoder.decode(toBytes(bytes)));
}

// ---------------------------------------------------------------------------
// Protocol Buffers (telemetry.proto)

const PB_VARINT = 0;
const PB_I64 = 1;
const PB_LEN = 2;
const PB_I32 = 5;

function pbTag(w, field, wireType) {
  pbVarint(w, (field << 3) | wireType);
}

function pbVarint(w, v) {
  v >>>= 0;
  while (v > 0x7f) {
    w.u8((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  w.u8(v);
}

const zigzag = (n) => ((n << 1) ^ (n >> 31)) >>> 0;
const unzigzag = (n) => (n >>> 1) ^ -(n & 1);

function pbUint(w, field, v) {
  if (v === 0) return;
  pbTag(w, field, PB_VARINT);
  pbVarint(w, v);
}

function pbSint(w, field, v) {
  if (v === 0) return;
  pbTag(w, field, PB_VARINT);
  pbVarint(w, zigzag(v));
}

function pbDouble(w, field, v) {
  if (v === 0) return;
  pbTag(w, field, PB_I64);
  w.f64(v);
}

function pbString(w, field, s) {
  if (!s) return;
  const b = textEncoder.encode(s);
  pbTag(w, field, PB_LEN);
  pbVarint(w, b.length);
  w.raw(b);
}

function pbEncodeObject(w, o) {
  pbUint(w, 1, o.id);
  pbUint(w, 2, o.kind);
  pbUint(w, 3, o.status);
  pbUint(w, 4, o.priority);
  pbSint(w, 5, o.latE6);
  pbSint(w, 6, o.lngE6);
  pbUint(w, 7, o.headingCdeg);
  pbUint(w, 8, o.speedCms);
  pbUint(w, 9, o.etaSeconds);
  pbUint(w, 10, o.requestId);
  pbDouble(w, 11, o.tsMs);
  pbString(w, 12, o.emergencyType);
  pbString(w, 13, o.responder);
  const trail = o.trail;
  if (trail && trail.length) {
    const packed = new ByteWriter(trail.length * 5);
    for (let i = 0; i < trail.length; i++) pbVarint(packed, zigzag(trail[i]));
    pbTag(w, 14, PB_LEN);
    pbVarint(w, packed.pos);
    w.raw(packed.bytes.subarray(0, packed.pos));
  }
}

export function encodeProtobuf(frame) {
  const w = new ByteWriter(64 + frame.objects.length * 160);
  const child = new ByteWriter(256);
  pbUint(w, 1, frame.seq);
  pbDouble(w, 2, frame.sentAtMs);
  for (const o of frame.objects) {
    child.pos = 0;
    pbEncodeObject(child, o);
    pbTag(w, 3, PB_LEN);
    pbVarint(w, child.pos);
    w.raw(child.bytes.subarray(0, child.pos));
  }
  return w.finish();
}

/** Cursor over protobuf bytes, in the style of `pbf`. */
class PbReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = viewOf(bytes);
    this.pos = 0;
  }

  varint() {
    const b = this.bytes;
    // Past the end, b[i] is undefined and every comparison below is false,
    // so a truncated varint stops early; the callers' end checks catch it.
    let byte = b[this.pos++];
    let v = byte & 0x7f;
    if (byte < 0x80) return v;
    byte = b[this.pos++]; v |= (byte & 0x7f) << 7; if (byte < 0x80) return v;
    byte = b[this.pos++]; v |= (byte & 0x7f) << 14; if (byte < 0x80) return v;
    byte = b[this.pos++]; v |= (byte & 0x7f) << 21; if (byte < 0x80) return v;
    byte = b[this.pos++]; v = (v | ((byte & 0x0f) << 28)) >>> 0;
    // uint32/int32 on the wire can be up to 10 bytes; the extra bytes carry
    // only sign extension, so skip them.
    while (byte >= 0x80) {
      if (this.pos >= b.length) throw new RangeError("protobuf varint out of range");
      byte = b[this.pos++];
    }
    return v;
  }

  double() {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  string() {
    const len = this.varint();
    const end = this.pos + len;
    if (end > this.bytes.length) throw new RangeError("protobuf string out of range");
    const s = textDecoder.decode(this.bytes.subarray(this.pos, end));
    this.pos = end;
    return s;
  }

  skip(wireType) {
    if (wireType === PB_VARINT) this.varint();
    else if (wireType === PB_I64) this.pos += 8;
    else if (wireType === PB_LEN) {
      // Not `this.pos += this.varint()`: that reads pos before varint() advances it.
      const len = this.varint();
      this.pos += len;
    }
    else if (wireType === PB_I32) this.pos += 4;
    else throw new Error(`unsupported protobuf wire type ${wireType}`);
  }
}

function pbReadPackedSint(r, target) {
  const len = r.varint();
  const end = r.pos + len;
  const values = [];
  while (r.pos < end) values.push(unzigzag(r.varint()));
  if (r.pos !== end) throw new RangeError("protobuf: packed field overruns its length");
  return target ? Int32Array.from(target.concat(values)) : Int32Array.from(values);
}

function pbDecodeObject(r, end) {
  const o = {
    id: 0, kind: 0, status: 0, priority: 0, latE6: 0, lngE6: 0, headingCdeg: 0, speedCms: 0,
    etaSeconds: 0, requestId: 0, tsMs: 0, emergencyType: "", responder: "", trail: EMPTY_TRAIL,
  };
  while (r.pos < end) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wt = tag & 7;
    switch (field) {
      case 1: o.id = r.varint(); break;
      case 2: o.kind = r.varint(); break;
      case 3: o.status = r.varint(); break;
      case 4: o.priority = r.varint(); break;
      case 5: o.latE6 = unzigzag(r.varint()); break;
      case 6: o.lngE6 = unzigzag(r.varint()); break;
      case 7: o.headingCdeg = r.varint(); break;
      case 8: o.speedCms = r.varint(); break;
      case 9: o.etaSeconds = r.varint(); break;
      case 10: o.requestId = r.varint(); break;
      case 11: o.tsMs = r.double(); break;
      case 12: o.emergencyType = r.string(); break;
      case 13: o.responder = r.string(); break;
      case 14:
        // Packed (wire type 2) is canonical; parsers must also accept
        // unpacked repeated elements (wire type 0).
        if (wt === PB_LEN) o.trail = pbReadPackedSint(r, o.trail.length ? Array.from(o.trail) : null);
        else o.trail = Int32Array.from([...o.trail, unzigzag(r.varint())]);
        break;
      default: r.skip(wt);
    }
  }
  if (r.pos !== end) throw new RangeError("protobuf: MapObject overruns its length");
  return o;
}

export function decodeProtobuf(input) {
  const r = new PbReader(toBytes(input));
  const frame = { seq: 0, sentAtMs: 0, objects: [] };
  const end = r.bytes.length;
  while (r.pos < end) {
    const tag = r.varint();
    const field = tag >>> 3;
    if (field === 1) frame.seq = r.varint();
    else if (field === 2) frame.sentAtMs = r.double();
    else if (field === 3) {
      const len = r.varint();
      frame.objects.push(pbDecodeObject(r, r.pos + len));
    } else r.skip(tag & 7);
  }
  if (r.pos !== end) throw new RangeError("protobuf: truncated frame");
  return frame;
}

/**
 * Streaming protobuf reader for the render path. It writes positions into
 * `out` without creating objects. It still has to walk every byte, because
 * protobuf fields can't be addressed directly.
 */
export function readProtobufPositions(input, out) {
  const r = new PbReader(toBytes(input));
  const end = r.bytes.length;
  let n = 0;
  while (r.pos < end) {
    const tag = r.varint();
    if (tag >>> 3 !== 3) {
      r.skip(tag & 7);
      continue;
    }
    const objEnd = r.varint() + r.pos;
    if (n >= out.capacity) growPositionBuffer(out, n + 1);
    let id = 0, kind = 0, status = 0, lat = 0, lng = 0, heading = 0;
    while (r.pos < objEnd) {
      const t = r.varint();
      switch (t >>> 3) {
        case 1: id = r.varint(); break;
        case 2: kind = r.varint(); break;
        case 3: status = r.varint(); break;
        case 5: lat = unzigzag(r.varint()); break;
        case 6: lng = unzigzag(r.varint()); break;
        case 7: heading = r.varint(); break;
        default: r.skip(t & 7);
      }
    }
    if (r.pos !== objEnd) throw new RangeError("protobuf: MapObject overruns its length");
    out.id[n] = id;
    out.kind[n] = kind;
    out.status[n] = status;
    out.latE6[n] = lat;
    out.lngE6[n] = lng;
    out.headingCdeg[n] = heading;
    n++;
  }
  if (r.pos !== end) throw new RangeError("protobuf: truncated frame");
  out.count = n;
  return n;
}

// ---------------------------------------------------------------------------
// FlatBuffers (telemetry.fbs)
//
// Buffer layout written by encodeFlatBuffers (all offsets little-endian):
//   [0]  uoffset to TelemetryFrame table
//   [4]  file identifier "HPTL"
//   frame vtable, frame table, objects vector (uoffsets), then for each
//   MapObject: [its vtable, if new] table, emergency_type, responder, trail.
// The official builder writes back to front, so its layout differs, but both
// are valid FlatBuffers. flatc's verifier and JSON decoder accept this one
// (see binary_conformance.js).

// MapObject vtable slots (4 + 2 * field id) and the inline layout used by
// encodeFlatBuffers. The inline offsets are only an encoder choice; readers
// always go through the vtable.
const FB_OBJ_FIELDS = 14;
const FB_OBJ_INLINE_SIZE = 52;
const FB_OBJ_INLINE = [
  /* id */ 4, /* kind */ 48, /* status */ 49, /* priority */ 50, /* lat_e6 */ 16, /* lng_e6 */ 20,
  /* heading_cdeg */ 44, /* speed_cms */ 46, /* eta_seconds */ 24, /* request_id */ 28, /* ts_ms */ 8,
  /* emergency_type */ 32, /* responder */ 36, /* trail */ 40,
];
const VT = {
  id: 4, kind: 6, status: 8, priority: 10, latE6: 12, lngE6: 14, headingCdeg: 16, speedCms: 18,
  etaSeconds: 20, requestId: 22, tsMs: 24, emergencyType: 26, responder: 28, trail: 30,
};

/** MapObject vtable slots (4 + 2 * field id); pinned to telemetry.fbs by tests. */
export const FLATBUFFERS_VTABLE_SLOTS = Object.freeze({ ...VT });

function fbWriteVtable(w, fieldOffsets, inlineSize) {
  w.align(2);
  const pos = w.pos;
  w.u16(4 + 2 * fieldOffsets.length);
  w.u16(inlineSize);
  for (const off of fieldOffsets) w.u16(off);
  return pos;
}

/** Writes a string or [int] vector and patches the uoffset at `slot`. */
function fbWriteOutOfLine(w, slot, write) {
  w.align(4);
  w.view.setUint32(slot, w.pos - slot, true);
  write();
}

export function encodeFlatBuffers(frame) {
  const objects = frame.objects;
  const w = new ByteWriter(64 + objects.length * 220);
  w.u32(0); // root uoffset, patched below
  for (let i = 0; i < 4; i++) w.u8(FLATBUFFERS_FILE_IDENTIFIER.charCodeAt(i));

  // TelemetryFrame: seq @4, sent_at_ms @8, objects @16; 20 bytes inline.
  const frameVt = fbWriteVtable(w, [4, 8, 16], 20);
  w.align(8);
  const frameTable = w.pos;
  w.view.setUint32(0, frameTable, true);
  w.i32(frameTable - frameVt);
  w.u32(frame.seq >>> 0);
  w.f64(frame.sentAtMs);
  const objectsSlot = w.pos;
  w.u32(0);

  w.align(4);
  w.view.setUint32(objectsSlot, w.pos - objectsSlot, true);
  w.u32(objects.length);
  const slots = w.pos;
  w.skip(objects.length * 4);

  // Absent strings/trail get a 0 vtable entry; vtables are shared by
  // presence pattern, like the official builder's vtable dedup.
  const vtables = new Map();
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    const emergencyType = o.emergencyType ? textEncoder.encode(o.emergencyType) : null;
    const responder = o.responder ? textEncoder.encode(o.responder) : null;
    const trail = o.trail && o.trail.length ? o.trail : null;
    const key = (emergencyType ? 1 : 0) | (responder ? 2 : 0) | (trail ? 4 : 0);
    let vt = vtables.get(key);
    if (vt === undefined) {
      const offsets = FB_OBJ_INLINE.slice(0, FB_OBJ_FIELDS);
      if (!emergencyType) offsets[11] = 0;
      if (!responder) offsets[12] = 0;
      if (!trail) offsets[13] = 0;
      vt = fbWriteVtable(w, offsets, FB_OBJ_INLINE_SIZE);
      vtables.set(key, vt);
    }
    w.align(8);
    const t = w.pos;
    const slot = slots + i * 4;
    w.view.setUint32(slot, t - slot, true);
    w.skip(FB_OBJ_INLINE_SIZE);
    const v = w.view;
    v.setInt32(t, t - vt, true);
    v.setUint32(t + 4, o.id >>> 0, true);
    v.setFloat64(t + 8, o.tsMs, true);
    v.setInt32(t + 16, o.latE6, true);
    v.setInt32(t + 20, o.lngE6, true);
    v.setUint32(t + 24, o.etaSeconds >>> 0, true);
    v.setUint32(t + 28, o.requestId >>> 0, true);
    v.setUint16(t + 44, o.headingCdeg, true);
    v.setUint16(t + 46, o.speedCms, true);
    v.setUint8(t + 48, o.kind);
    v.setUint8(t + 49, o.status);
    v.setUint8(t + 50, o.priority);
    for (const [slotOff, str] of [[32, emergencyType], [36, responder]]) {
      if (!str) continue;
      fbWriteOutOfLine(w, t + slotOff, () => {
        w.u32(str.length);
        w.raw(str);
        w.u8(0);
      });
    }
    if (trail) {
      fbWriteOutOfLine(w, t + 40, () => {
        w.u32(trail.length);
        for (let k = 0; k < trail.length; k++) w.i32(trail[k]);
      });
    }
  }
  w.align(8);
  return w.finish();
}

/**
 * Flyweight MapObject accessor over a FlatBuffers buffer. Every getter
 * resolves its vtable slot on each call, exactly like flatc-generated code.
 * Reuse one instance across objects (`frame.object(i, reuse)`) to avoid
 * allocating per object.
 */
export class FlatMapObject {
  __init(frame, pos) {
    this.frame = frame;
    this.view = frame.view;
    this.bb_pos = pos;
    return this;
  }

  __offset(vtableOffset) {
    const v = this.view;
    const vt = this.bb_pos - v.getInt32(this.bb_pos, true);
    return vtableOffset < v.getUint16(vt, true) ? v.getUint16(vt + vtableOffset, true) : 0;
  }

  #u32(slot) { const o = this.__offset(slot); return o ? this.view.getUint32(this.bb_pos + o, true) : 0; }
  #i32(slot) { const o = this.__offset(slot); return o ? this.view.getInt32(this.bb_pos + o, true) : 0; }
  #u16(slot) { const o = this.__offset(slot); return o ? this.view.getUint16(this.bb_pos + o, true) : 0; }
  #u8(slot) { const o = this.__offset(slot); return o ? this.view.getUint8(this.bb_pos + o) : 0; }

  #vector(slot) {
    const o = this.__offset(slot);
    if (!o) return -1;
    const at = this.bb_pos + o;
    return at + this.view.getUint32(at, true);
  }

  id() { return this.#u32(VT.id); }
  kind() { return this.#u8(VT.kind); }
  status() { return this.#u8(VT.status); }
  priority() { return this.#u8(VT.priority); }
  latE6() { return this.#i32(VT.latE6); }
  lngE6() { return this.#i32(VT.lngE6); }
  headingCdeg() { return this.#u16(VT.headingCdeg); }
  speedCms() { return this.#u16(VT.speedCms); }
  etaSeconds() { return this.#u32(VT.etaSeconds); }
  requestId() { return this.#u32(VT.requestId); }
  tsMs() { const o = this.__offset(VT.tsMs); return o ? this.view.getFloat64(this.bb_pos + o, true) : 0; }

  #string(slot) {
    const at = this.#vector(slot);
    if (at < 0) return "";
    const len = this.view.getUint32(at, true);
    return textDecoder.decode(this.frame.bytes.subarray(at + 4, at + 4 + len));
  }

  emergencyType() { return this.#string(VT.emergencyType); }
  responder() { return this.#string(VT.responder); }

  trailLength() {
    const at = this.#vector(VT.trail);
    return at < 0 ? 0 : this.view.getUint32(at, true);
  }

  trail(index) {
    const at = this.#vector(VT.trail);
    return at < 0 ? 0 : this.view.getInt32(at + 4 + index * 4, true);
  }

  /** Int32Array view over the trail; zero-copy when the buffer is 4-aligned. */
  trailArray() {
    const at = this.#vector(VT.trail);
    if (at < 0) return EMPTY_TRAIL;
    return int32Slice(this.frame.bytes, this.view, at + 4, this.view.getUint32(at, true));
  }
}

export class FlatTelemetryFrame {
  constructor(input) {
    const bytes = toBytes(input);
    if (bytes.length < 8) throw new RangeError("buffer too small for a FlatBuffers frame");
    this.bytes = bytes;
    this.view = viewOf(bytes);
    this.bb_pos = this.view.getUint32(0, true);
    const vt = this.bb_pos - this.view.getInt32(this.bb_pos, true);
    this.vtSize = this.view.getUint16(vt, true);
    this.vt = vt;
    const objOff = this.#offset(8);
    this.objectsAt = objOff ? this.bb_pos + objOff + this.view.getUint32(this.bb_pos + objOff, true) : -1;
  }

  #offset(slot) {
    return slot < this.vtSize ? this.view.getUint16(this.vt + slot, true) : 0;
  }

  /** True when the buffer carries the "HPTL" file identifier. */
  static hasIdentifier(input) {
    const b = toBytes(input);
    if (b.length < 8) return false;
    for (let i = 0; i < 4; i++) if (b[4 + i] !== FLATBUFFERS_FILE_IDENTIFIER.charCodeAt(i)) return false;
    return true;
  }

  seq() { const o = this.#offset(4); return o ? this.view.getUint32(this.bb_pos + o, true) : 0; }
  sentAtMs() { const o = this.#offset(6); return o ? this.view.getFloat64(this.bb_pos + o, true) : 0; }
  objectsLength() { return this.objectsAt < 0 ? 0 : this.view.getUint32(this.objectsAt, true); }

  object(index, reuse) {
    const slot = this.objectsAt + 4 + index * 4;
    return (reuse || new FlatMapObject()).__init(this, slot + this.view.getUint32(slot, true));
  }
}

export function openFlatBuffersFrame(input) {
  return new FlatTelemetryFrame(input);
}

/**
 * Render-path reader. It resolves each object's vtable once and caches it,
 * because the encoder shares vtables between objects. Allocates nothing.
 */
export function readFlatBuffersPositions(input, out) {
  const bytes = toBytes(input);
  const v = viewOf(bytes);
  const root = v.getUint32(0, true);
  const rootVt = root - v.getInt32(root, true);
  const objectsSlot = 8 < v.getUint16(rootVt, true) ? v.getUint16(rootVt + 8, true) : 0;
  if (!objectsSlot) {
    out.count = 0;
    return 0;
  }
  const vec = root + objectsSlot + v.getUint32(root + objectsSlot, true);
  const n = v.getUint32(vec, true);
  if (n > out.capacity) growPositionBuffer(out, n);
  let lastVt = -1, oId = 0, oKind = 0, oStatus = 0, oLat = 0, oLng = 0, oHeading = 0;
  for (let i = 0; i < n; i++) {
    const slot = vec + 4 + i * 4;
    const t = slot + v.getUint32(slot, true);
    const vt = t - v.getInt32(t, true);
    if (vt !== lastVt) {
      const size = v.getUint16(vt, true);
      oId = VT.id < size ? v.getUint16(vt + VT.id, true) : 0;
      oKind = VT.kind < size ? v.getUint16(vt + VT.kind, true) : 0;
      oStatus = VT.status < size ? v.getUint16(vt + VT.status, true) : 0;
      oLat = VT.latE6 < size ? v.getUint16(vt + VT.latE6, true) : 0;
      oLng = VT.lngE6 < size ? v.getUint16(vt + VT.lngE6, true) : 0;
      oHeading = VT.headingCdeg < size ? v.getUint16(vt + VT.headingCdeg, true) : 0;
      lastVt = vt;
    }
    out.id[i] = oId ? v.getUint32(t + oId, true) : 0;
    out.kind[i] = oKind ? v.getUint8(t + oKind) : 0;
    out.status[i] = oStatus ? v.getUint8(t + oStatus) : 0;
    out.latE6[i] = oLat ? v.getInt32(t + oLat, true) : 0;
    out.lngE6[i] = oLng ? v.getInt32(t + oLng, true) : 0;
    out.headingCdeg[i] = oHeading ? v.getUint16(t + oHeading, true) : 0;
  }
  out.count = n;
  return n;
}

function fbMaterialize(m) {
  return {
    id: m.id(), kind: m.kind(), status: m.status(), priority: m.priority(), latE6: m.latE6(), lngE6: m.lngE6(),
    headingCdeg: m.headingCdeg(), speedCms: m.speedCms(), etaSeconds: m.etaSeconds(), requestId: m.requestId(),
    tsMs: m.tsMs(), emergencyType: m.emergencyType(), responder: m.responder(), trail: Int32Array.from(m.trailArray()),
  };
}

export function decodeFlatBuffers(input) {
  const f = openFlatBuffersFrame(input);
  const n = f.objectsLength();
  const objects = new Array(n);
  const m = new FlatMapObject();
  for (let i = 0; i < n; i++) objects[i] = fbMaterialize(f.object(i, m));
  return { seq: f.seq(), sentAtMs: f.sentAtMs(), objects };
}

// ---------------------------------------------------------------------------
// Cap'n Proto (telemetry.capnp)
//
// encodeCapnp writes a single-segment, unpacked message:
//   [0] u32 segment count - 1 (= 0)   [4] u32 segment size in words
//   [8] segment: root struct pointer, TelemetryFrame, the MapObject
//       composite list, then the Text/List(Int32) bodies.
// The reader also accepts multi-segment messages (far and double-far
// pointers), which the official C++/Rust builders produce once a message
// outgrows its first segment. It does not accept packed encoding.
// The data-section byte offsets below come from the `bits[...]` ranges
// that `capnp compile -ocapnp` prints (copied into telemetry.capnp).

const CP_OBJ_DATA_WORDS = 5;
const CP_OBJ_PTR_WORDS = 3;
const CP = {
  id: 0, latE6: 4, lngE6: 8, etaSeconds: 12, requestId: 16, headingCdeg: 20, speedCms: 22, tsMs: 24,
  kind: 32, status: 34, priority: 36,
};
/** MapObject layout; pinned to the `bits[...]` comments in telemetry.capnp by tests. */
export const CAPNP_MAP_OBJECT_LAYOUT = Object.freeze({
  dataWords: CP_OBJ_DATA_WORDS,
  ptrWords: CP_OBJ_PTR_WORDS,
  byteOffsets: Object.freeze({ ...CP }),
  pointers: Object.freeze({ emergencyType: 0, responder: 1, trail: 2 }),
});

const CP_ELEM_BYTE = 2;
const CP_ELEM_FOUR = 4;
const CP_ELEM_COMPOSITE = 7;

function cpStructPtr(v, at, target, dataWords, ptrWords) {
  v.setUint32(at, ((((target - at - 8) / 8) << 2) | 0) >>> 0, true);
  v.setUint32(at + 4, dataWords | (ptrWords << 16), true);
}

function cpListPtr(v, at, target, elemSize, count) {
  v.setUint32(at, ((((target - at - 8) / 8) << 2) | 1) >>> 0, true);
  v.setUint32(at + 4, (elemSize | (count << 3)) >>> 0, true);
}

export function encodeCapnp(frame) {
  const objects = frame.objects;
  const n = objects.length;
  const stride = (CP_OBJ_DATA_WORDS + CP_OBJ_PTR_WORDS) * 8;
  const w = new ByteWriter(64 + n * 240);
  w.skip(8); // stream header, patched below
  const seg = w.pos;

  // Root pointer, then TelemetryFrame (2 data words, 1 pointer).
  w.skip(8);
  const frameAt = w.pos;
  w.skip(24);
  cpStructPtr(w.view, seg, frameAt, 2, 1);
  w.view.setUint32(frameAt, frame.seq >>> 0, true);
  w.view.setFloat64(frameAt + 8, frame.sentAtMs, true);

  // Composite list: tag word, then n inline structs.
  const tagAt = w.pos;
  w.skip(8 + n * stride);
  cpListPtr(w.view, frameAt + 16, tagAt, CP_ELEM_COMPOSITE, n * (stride / 8));
  w.view.setUint32(tagAt, (n << 2) >>> 0, true);
  w.view.setUint32(tagAt + 4, CP_OBJ_DATA_WORDS | (CP_OBJ_PTR_WORDS << 16), true);

  for (let i = 0; i < n; i++) {
    const o = objects[i];
    const s = tagAt + 8 + i * stride;
    const v = w.view;
    v.setUint32(s + CP.id, o.id >>> 0, true);
    v.setInt32(s + CP.latE6, o.latE6, true);
    v.setInt32(s + CP.lngE6, o.lngE6, true);
    v.setUint32(s + CP.etaSeconds, o.etaSeconds >>> 0, true);
    v.setUint32(s + CP.requestId, o.requestId >>> 0, true);
    v.setUint16(s + CP.headingCdeg, o.headingCdeg, true);
    v.setUint16(s + CP.speedCms, o.speedCms, true);
    v.setFloat64(s + CP.tsMs, o.tsMs, true);
    v.setUint16(s + CP.kind, o.kind, true);
    v.setUint16(s + CP.status, o.status, true);
    v.setUint16(s + CP.priority, o.priority, true);
    const ptrs = s + CP_OBJ_DATA_WORDS * 8;
    // Text is a List(UInt8) that includes a NUL terminator; empty text is
    // written as a null pointer (the default).
    const texts = [o.emergencyType, o.responder];
    for (let p = 0; p < 2; p++) {
      if (!texts[p]) continue;
      const b = textEncoder.encode(texts[p]);
      const at = w.pos;
      w.raw(b);
      w.u8(0);
      w.align(8);
      cpListPtr(w.view, ptrs + p * 8, at, CP_ELEM_BYTE, b.length + 1);
    }
    const trail = o.trail;
    if (trail && trail.length) {
      const at = w.pos;
      for (let k = 0; k < trail.length; k++) w.i32(trail[k]);
      w.align(8);
      cpListPtr(w.view, ptrs + 16, at, CP_ELEM_FOUR, trail.length);
    }
  }
  w.view.setUint32(0, 0, true);
  w.view.setUint32(4, (w.pos - seg) / 8, true);
  return w.finish();
}

/**
 * Follows the pointer at byte `at`, including far and double-far pointers.
 * Returns [contentByte, lo, hi], where lo/hi are the words that describe the
 * content (the pointer itself, or the landing pad's tag), or null for a
 * null pointer.
 */
function cpResolve(v, segStarts, at) {
  const lo = v.getUint32(at, true);
  const hi = v.getUint32(at + 4, true);
  if (lo === 0 && hi === 0) return null;
  if ((lo & 3) !== 2) return [at + 8 + ((lo | 0) >> 2) * 8, lo, hi];
  const seg = segStarts[hi];
  if (seg === undefined) throw new RangeError("capnp: far pointer to a missing segment");
  const pad = seg + (lo >>> 3) * 8;
  if ((lo & 4) === 0) {
    // Single-far: the landing pad is an ordinary pointer.
    const padLo = v.getUint32(pad, true);
    if ((padLo & 3) === 2) throw new Error("capnp: far pointer lands on another far pointer");
    return [pad + 8 + ((padLo | 0) >> 2) * 8, padLo, v.getUint32(pad + 4, true)];
  }
  // Double-far: pad[0] is a far pointer to the content, pad[1] is its tag.
  const farLo = v.getUint32(pad, true);
  const contentSeg = segStarts[v.getUint32(pad + 4, true)];
  if ((farLo & 7) !== 2 || contentSeg === undefined) throw new Error("capnp: malformed double-far landing pad");
  return [contentSeg + (farLo >>> 3) * 8, v.getUint32(pad + 8, true), v.getUint32(pad + 12, true)];
}

/** Resolves a list pointer; returns [targetByte, elemSize, count] or null. */
function cpList(v, segStarts, at) {
  const r = cpResolve(v, segStarts, at);
  if (!r) return null;
  if ((r[1] & 3) !== 1) throw new Error("capnp: expected a list pointer");
  return [r[0], r[2] & 7, r[2] >>> 3];
}

/**
 * Flyweight MapObject accessor over a Cap'n Proto buffer. Fields beyond an
 * older writer's data or pointer section read as the default.
 */
export class CapnpMapObject {
  __init(frame, pos) {
    this.frame = frame;
    this.view = frame.view;
    this.pos = pos;
    // Resolved trail list for this object (see #trailRef); -1 = not yet.
    this.trailFor = -1;
    this.trailPos = 0;
    this.trailLen = 0;
    return this;
  }

  /** Resolves the trail pointer once per object, without allocating for near pointers. */
  #trailRef() {
    if (this.trailFor === this.pos) return;
    this.trailFor = this.pos;
    this.trailPos = 0;
    this.trailLen = 0;
    if (this.frame.elemPtrWords <= 2) return;
    const at = this.pos + this.frame.elemDataBytes + 16;
    const v = this.view;
    const lo = v.getUint32(at, true);
    const hi = v.getUint32(at + 4, true);
    if (lo === 0 && hi === 0) return;
    let pos, elem, len;
    if ((lo & 3) === 1) {
      pos = at + 8 + ((lo | 0) >> 2) * 8;
      elem = hi & 7;
      len = hi >>> 3;
    } else {
      [pos, elem, len] = cpList(v, this.frame.segStarts, at);
    }
    if (elem !== CP_ELEM_FOUR) throw new Error("capnp: trail must be List(Int32)");
    this.trailPos = pos;
    this.trailLen = len;
  }

  #d(off, size) { return off + size <= this.frame.elemDataBytes; }

  id() { return this.#d(CP.id, 4) ? this.view.getUint32(this.pos + CP.id, true) : 0; }
  latE6() { return this.#d(CP.latE6, 4) ? this.view.getInt32(this.pos + CP.latE6, true) : 0; }
  lngE6() { return this.#d(CP.lngE6, 4) ? this.view.getInt32(this.pos + CP.lngE6, true) : 0; }
  etaSeconds() { return this.#d(CP.etaSeconds, 4) ? this.view.getUint32(this.pos + CP.etaSeconds, true) : 0; }
  requestId() { return this.#d(CP.requestId, 4) ? this.view.getUint32(this.pos + CP.requestId, true) : 0; }
  headingCdeg() { return this.#d(CP.headingCdeg, 2) ? this.view.getUint16(this.pos + CP.headingCdeg, true) : 0; }
  speedCms() { return this.#d(CP.speedCms, 2) ? this.view.getUint16(this.pos + CP.speedCms, true) : 0; }
  tsMs() { return this.#d(CP.tsMs, 8) ? this.view.getFloat64(this.pos + CP.tsMs, true) : 0; }
  kind() { return this.#d(CP.kind, 2) ? this.view.getUint16(this.pos + CP.kind, true) : 0; }
  status() { return this.#d(CP.status, 2) ? this.view.getUint16(this.pos + CP.status, true) : 0; }
  priority() { return this.#d(CP.priority, 2) ? this.view.getUint16(this.pos + CP.priority, true) : 0; }

  #ptr(index) {
    if (index >= this.frame.elemPtrWords) return null;
    return cpList(this.view, this.frame.segStarts, this.pos + this.frame.elemDataBytes + index * 8);
  }

  #text(index) {
    const l = this.#ptr(index);
    if (!l) return "";
    if (l[1] !== CP_ELEM_BYTE) throw new Error("capnp: Text must be a byte list");
    return textDecoder.decode(this.frame.bytes.subarray(l[0], l[0] + l[2] - 1));
  }

  emergencyType() { return this.#text(0); }
  responder() { return this.#text(1); }

  trailLength() {
    this.#trailRef();
    return this.trailLen;
  }

  /** One trail value without allocating (trailArray() creates a view). */
  trail(index) {
    this.#trailRef();
    return index < this.trailLen ? this.view.getInt32(this.trailPos + index * 4, true) : 0;
  }

  trailArray() {
    this.#trailRef();
    return this.trailLen ? int32Slice(this.frame.bytes, this.view, this.trailPos, this.trailLen) : EMPTY_TRAIL;
  }
}

export class CapnpTelemetryFrame {
  constructor(input) {
    const bytes = toBytes(input);
    const v = viewOf(bytes);
    if (bytes.length < 16) throw new RangeError("buffer too small for a Cap'n Proto message");
    // Segment table: u32 count-1, u32 size (words) per segment, padded to 8.
    const segCount = v.getUint32(0, true) + 1;
    if (segCount > 512) throw new RangeError("capnp: too many segments");
    const segStarts = new Array(segCount);
    let at = (4 + 4 * segCount + 7) & ~7;
    for (let i = 0; i < segCount; i++) {
      segStarts[i] = at;
      at += v.getUint32(4 + 4 * i, true) * 8;
    }
    if (at > bytes.length) throw new RangeError("capnp: segments exceed buffer");
    this.bytes = bytes;
    this.view = v;
    this.segStarts = segStarts;
    const root = cpResolve(v, segStarts, segStarts[0]);
    if (!root || (root[1] & 3) !== 0) throw new Error("capnp: root must be a struct pointer");
    const hi = root[2];
    this.pos = root[0];
    this.dataBytes = (hi & 0xffff) * 8;
    const ptrWords = hi >>> 16;
    this.count = 0;
    this.elemsAt = 0;
    this.elemStride = 0;
    this.elemDataBytes = 0;
    this.elemPtrWords = 0;
    const list = ptrWords > 0 ? cpList(v, segStarts, this.pos + this.dataBytes) : null;
    if (list) {
      if (list[1] !== CP_ELEM_COMPOSITE) throw new Error("capnp: objects must be a struct list");
      const tag = list[0];
      const tagHi = v.getUint32(tag + 4, true);
      this.count = v.getUint32(tag, true) >>> 2;
      this.elemDataBytes = (tagHi & 0xffff) * 8;
      this.elemPtrWords = tagHi >>> 16;
      this.elemStride = this.elemDataBytes + this.elemPtrWords * 8;
      this.elemsAt = tag + 8;
      if (this.count * this.elemStride > list[2] * 8) throw new RangeError("capnp: list tag exceeds list size");
    }
  }

  seq() { return this.dataBytes >= 4 ? this.view.getUint32(this.pos, true) : 0; }
  sentAtMs() { return this.dataBytes >= 16 ? this.view.getFloat64(this.pos + 8, true) : 0; }
  objectsLength() { return this.count; }

  object(index, reuse) {
    return (reuse || new CapnpMapObject()).__init(this, this.elemsAt + index * this.elemStride);
  }
}

export function openCapnpFrame(input) {
  return new CapnpTelemetryFrame(input);
}

/** Render-path reader: fixed offsets, no vtables, allocates nothing. */
export function readCapnpPositions(input, out) {
  const f = input instanceof CapnpTelemetryFrame ? input : new CapnpTelemetryFrame(input);
  const n = f.count;
  if (n > out.capacity) growPositionBuffer(out, n);
  const v = f.view;
  const stride = f.elemStride;
  if (f.elemDataBytes < 40) {
    // Older/smaller struct layout: take the checked path.
    const m = new CapnpMapObject();
    for (let i = 0; i < n; i++) {
      f.object(i, m);
      out.id[i] = m.id(); out.kind[i] = m.kind(); out.status[i] = m.status();
      out.latE6[i] = m.latE6(); out.lngE6[i] = m.lngE6(); out.headingCdeg[i] = m.headingCdeg();
    }
  } else {
    for (let i = 0, s = f.elemsAt; i < n; i++, s += stride) {
      out.id[i] = v.getUint32(s + CP.id, true);
      out.kind[i] = v.getUint16(s + CP.kind, true);
      out.status[i] = v.getUint16(s + CP.status, true);
      out.latE6[i] = v.getInt32(s + CP.latE6, true);
      out.lngE6[i] = v.getInt32(s + CP.lngE6, true);
      out.headingCdeg[i] = v.getUint16(s + CP.headingCdeg, true);
    }
  }
  out.count = n;
  return n;
}

function cpMaterialize(m) {
  return {
    id: m.id(), kind: m.kind(), status: m.status(), priority: m.priority(), latE6: m.latE6(), lngE6: m.lngE6(),
    headingCdeg: m.headingCdeg(), speedCms: m.speedCms(), etaSeconds: m.etaSeconds(), requestId: m.requestId(),
    tsMs: m.tsMs(), emergencyType: m.emergencyType(), responder: m.responder(), trail: Int32Array.from(m.trailArray()),
  };
}

export function decodeCapnp(input) {
  const f = openCapnpFrame(input);
  const objects = new Array(f.count);
  const m = new CapnpMapObject();
  for (let i = 0; i < f.count; i++) objects[i] = cpMaterialize(f.object(i, m));
  return { seq: f.seq(), sentAtMs: f.sentAtMs(), objects };
}

// ---------------------------------------------------------------------------
// Format-independent entry points

/**
 * Preallocated struct-of-arrays that the render path fills. Mapbox custom
 * layers and deck.gl-style attribute buffers can use these arrays directly.
 */
export function createPositionBuffer(capacity = 1024) {
  return {
    count: 0,
    capacity,
    id: new Uint32Array(capacity),
    kind: new Uint8Array(capacity),
    status: new Uint8Array(capacity),
    latE6: new Int32Array(capacity),
    lngE6: new Int32Array(capacity),
    headingCdeg: new Uint16Array(capacity),
  };
}

/** Grows `out` in place to hold at least `min` objects (amortised doubling). */
export function growPositionBuffer(out, min) {
  let capacity = Math.max(1, out.capacity);
  while (capacity < min) capacity *= 2;
  for (const key of ["id", "kind", "status", "latE6", "lngE6", "headingCdeg"]) {
    const next = new out[key].constructor(capacity);
    next.set(out[key]);
    out[key] = next;
  }
  out.capacity = capacity;
  return out;
}

function readJsonPositions(input, out) {
  const objects = decodeJson(input).objects;
  const n = objects.length;
  if (n > out.capacity) growPositionBuffer(out, n);
  for (let i = 0; i < n; i++) {
    const o = objects[i];
    out.id[i] = o.id;
    out.kind[i] = o.kind;
    out.status[i] = o.status;
    out.latE6[i] = o.latE6;
    out.lngE6[i] = o.lngE6;
    out.headingCdeg[i] = o.headingCdeg;
  }
  out.count = n;
  return n;
}

const ENCODERS = { json: encodeJson, protobuf: encodeProtobuf, flatbuffers: encodeFlatBuffers, capnp: encodeCapnp };
const DECODERS = {
  json: (b) => {
    const f = decodeJson(b);
    for (const o of f.objects) o.trail = Int32Array.from(o.trail || []);
    return f;
  },
  protobuf: decodeProtobuf,
  flatbuffers: decodeFlatBuffers,
  capnp: decodeCapnp,
};
const POSITION_READERS = {
  json: readJsonPositions,
  protobuf: readProtobufPositions,
  flatbuffers: readFlatBuffersPositions,
  capnp: readCapnpPositions,
};

function pick(table, format) {
  const fn = table[format];
  if (!fn) throw new Error(`unknown telemetry format "${format}" (expected one of ${FORMATS.join(", ")})`);
  return fn;
}

export function encodeFrame(format, frame) {
  return pick(ENCODERS, format)(frame);
}

/** Fully materialises a frame into plain objects (same shape for every format). */
export function decodeFrame(format, bytes) {
  return pick(DECODERS, format)(bytes);
}

/** Render-path decode into a position buffer. Returns the object count. */
export function readPositions(format, bytes, out) {
  return pick(POSITION_READERS, format)(bytes, out);
}
