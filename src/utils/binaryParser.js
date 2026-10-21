/**
 * Canonical binary telemetry frame parser (JS fallback + reference parity).
 *
 * Wire format (little-endian, fixed 40-byte header):
 *
 *   offset size field
 *   0      4    magic 0x48454C50 ("HELP")
 *   4      1    version (1)
 *   5      1    kind (1 location, 2 beacon, 3 heartbeat, 4 dispatch ack,
 *                      5 dispatch update)
 *   6      1    priority (0 heartbeat, 1 normal, 2 critical)
 *   7      1    flags (bit0 = force critical, bit1 = compressed,
 *                       bit2 = encrypted)
 *   8      4    sequence (u32)
 *   12     8    timestamp (f64, ms since epoch)
 *   20     8    latitude (f64)
 *   28     8    longitude (f64)
 *   36     4    accuracy metres (f32)
 *
 * The WASM reader in src/wasm/telemetry_reader implements the exact same
 * layout; `test/telemetry-parser.test.js` asserts parity.
 */

export const FRAME_MAGIC = 0x48454c50;
export const FRAME_VERSION = 1;
export const FRAME_BYTES = 40;

export const FRAME_KIND = Object.freeze({
  LOCATION: 1,
  BEACON: 2,
  HEARTBEAT: 3,
  DISPATCH_ACK: 4,
  DISPATCH_UPDATE: 5,
});

export const KIND_NAME = Object.freeze({
  1: 'location',
  2: 'beacon',
  3: 'heartbeat',
  4: 'dispatch_ack',
  5: 'dispatch_update',
});

export const PRIORITY_NAME = Object.freeze({
  0: 'heartbeat',
  1: 'normal',
  2: 'critical',
});

export class BinaryParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BinaryParseError';
    this.code = code;
  }
}

function asBytes(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('parseFrame expects an ArrayBuffer or ArrayBufferView');
}

export function priorityFor(kind, explicitPriority, flags) {
  if ((flags & 0x01) !== 0) return 'critical';
  if (kind === FRAME_KIND.DISPATCH_ACK || kind === FRAME_KIND.DISPATCH_UPDATE) {
    return 'critical';
  }
  if (kind === FRAME_KIND.HEARTBEAT) return 'heartbeat';
  return PRIORITY_NAME[explicitPriority] || 'normal';
}

/**
 * Parse one frame.
 *
 * @param {ArrayBuffer|ArrayBufferView} input
 * @param {number} [offset]
 * @param {object} [out] Optional reusable target object (zero-allocation path).
 */
export function parseFrame(input, offset = 0, out) {
  const bytes = asBytes(input);
  if (offset < 0 || offset + FRAME_BYTES > bytes.byteLength) {
    throw new BinaryParseError('truncated', `need ${FRAME_BYTES} bytes at offset ${offset}, got ${bytes.byteLength - offset}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(offset, true);
  if (magic !== FRAME_MAGIC) {
    throw new BinaryParseError('bad_magic', `bad magic 0x${magic.toString(16)}`);
  }

  const version = view.getUint8(offset + 4);
  if (version !== FRAME_VERSION) {
    throw new BinaryParseError('bad_version', `unsupported frame version ${version}`);
  }

  const kind = view.getUint8(offset + 5);
  if (!KIND_NAME[kind]) {
    throw new BinaryParseError('bad_kind', `unknown frame kind ${kind}`);
  }

  const declaredPriority = view.getUint8(offset + 6);
  if (!PRIORITY_NAME[declaredPriority]) {
    throw new BinaryParseError('bad_priority', `unknown priority ${declaredPriority}`);
  }

  const flags = view.getUint8(offset + 7);
  const seq = view.getUint32(offset + 8, true);
  const ts = view.getFloat64(offset + 12, true);
  const lat = view.getFloat64(offset + 20, true);
  const lng = view.getFloat64(offset + 28, true);
  const accuracy = view.getFloat32(offset + 36, true);

  if (!Number.isFinite(ts) || !Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracy)) {
    throw new BinaryParseError('non_finite', 'frame contains non-finite coordinates');
  }
  if (lat < -90 || lat > 90) {
    throw new BinaryParseError('bad_latitude', `latitude out of range: ${lat}`);
  }
  if (lng < -180 || lng > 180) {
    throw new BinaryParseError('bad_longitude', `longitude out of range: ${lng}`);
  }

  const priority = priorityFor(kind, declaredPriority, flags);
  const target = out || {};
  target.magic = magic;
  target.version = version;
  target.kind = kind;
  target.kindName = KIND_NAME[kind];
  target.priority = priority;
  target.flags = flags;
  target.seq = seq;
  target.ts = ts;
  target.lat = lat;
  target.lng = lng;
  target.accuracy = accuracy;
  target.bytes = FRAME_BYTES;
  return target;
}

/** Parse `count` contiguous frames. */
export function parseBatch(input, count, options = {}) {
  const bytes = asBytes(input);
  const total = count ?? Math.floor(bytes.byteLength / FRAME_BYTES);
  const out = [];
  for (let i = 0; i < total; i++) {
    try {
      out.push(parseFrame(bytes, i * FRAME_BYTES, options.reuse ? {} : undefined));
    } catch (error) {
      if (options.stopOnError !== false) throw error;
      out.push({ error: error.code || 'parse_error', index: i });
    }
  }
  return out;
}

/**
 * Encode a frame (used by the worker/bench and by the Rust parity tests).
 * @returns {ArrayBuffer}
 */
export function encodeFrame(frame = {}) {
  const buffer = new ArrayBuffer(FRAME_BYTES);
  const view = new DataView(buffer);
  const kind = frame.kind ?? FRAME_KIND.LOCATION;
  const priority = frame.priority ?? (kind === FRAME_KIND.HEARTBEAT ? 0 : kind >= FRAME_KIND.DISPATCH_ACK ? 2 : 1);
  view.setUint32(0, FRAME_MAGIC, true);
  view.setUint8(4, frame.version ?? FRAME_VERSION);
  view.setUint8(5, kind);
  view.setUint8(6, priority);
  view.setUint8(7, frame.flags ?? 0);
  view.setUint32(8, frame.seq ?? 0, true);
  view.setFloat64(12, frame.ts ?? Date.now(), true);
  view.setFloat64(20, frame.lat ?? 0, true);
  view.setFloat64(28, frame.lng ?? 0, true);
  view.setFloat32(36, frame.accuracy ?? 0, true);
  return buffer;
}

/** True when `kind` is dispatch-critical even without the flag bit. */
export function isCriticalKind(kind) {
  return kind === FRAME_KIND.DISPATCH_ACK || kind === FRAME_KIND.DISPATCH_UPDATE;
}

export default { parseFrame, parseBatch, encodeFrame, FRAME_BYTES, FRAME_MAGIC };
