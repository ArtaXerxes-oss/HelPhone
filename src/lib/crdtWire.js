/**
 * Compact binary wire encoding for incident-map CRDT gossip (#894, ADR-004).
 *
 * The spike moved 50 MB of JSON gossip. This encoding carries the same
 * StateVectorDoc updates (`{type:"delta",lamport,ops}` and
 * `{type:"snapshot",lamport,sv,entries}`) plus the gossip envelope, using:
 *
 *  - LEB128 varints for every integer, zig-zag for signed deltas;
 *  - one string dictionary per message: entity keys, client ids, string
 *    values and object property names are written once and referenced by
 *    index after that;
 *  - ops grouped by client in clock order, so each op stores its clock and
 *    Lamport time as small deltas from the previous op of that client.
 *
 * Values are JSON-compatible (null, booleans, numbers, strings, arrays,
 * plain objects). `decode(encode(x))` returns a structure equal to `x` with
 * ops reordered by (client, clock), which `applyUpdate` sorts anyway.
 */

const MAGIC = [0x48, 0x50, 0x43, 0x57]; // "HPCW"
const VERSION = 1;

const KIND = { delta: 1, snapshot: 2, gossip: 3 };
const TAG = { null: 0, false: 1, true: 2, uint: 3, negint: 4, float: 5, string: 6, array: 7, object: 8 };
const MAX_DEPTH = 32;

export class WireFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "WireFormatError";
  }
}

// ── Byte writer / reader ────────────────────────────────────────────────────

class Writer {
  constructor() {
    this.buf = new Uint8Array(256);
    this.len = 0;
  }
  #grow(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(b) {
    this.#grow(1);
    this.buf[this.len++] = b;
  }
  bytes(arr) {
    this.#grow(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  }
  uint(n) {
    if (!Number.isSafeInteger(n) || n < 0) throw new WireFormatError(`Not a safe unsigned integer: ${n}`);
    while (n >= 0x80) {
      this.byte((n % 0x80) | 0x80);
      n = Math.floor(n / 0x80);
    }
    this.byte(n);
  }
  sint(n) {
    // zig-zag without 32-bit overflow
    this.uint(n >= 0 ? n * 2 : -n * 2 - 1);
  }
  float(x) {
    this.#grow(8);
    new DataView(this.buf.buffer).setFloat64(this.len, x, true);
    this.len += 8;
  }
  result() {
    return this.buf.slice(0, this.len);
  }
}

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.i = 0;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  byte() {
    if (this.i >= this.b.length) throw new WireFormatError("Truncated message");
    return this.b[this.i++];
  }
  uint() {
    let n = 0;
    let mul = 1;
    for (let shift = 0; shift < 64; shift += 7) {
      const b = this.byte();
      n += (b & 0x7f) * mul;
      if (!(b & 0x80)) {
        if (!Number.isSafeInteger(n)) throw new WireFormatError("Varint out of range");
        return n;
      }
      mul *= 0x80;
    }
    throw new WireFormatError("Varint too long");
  }
  sint() {
    const z = this.uint();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }
  float() {
    if (this.i + 8 > this.b.length) throw new WireFormatError("Truncated message");
    const x = this.view.getFloat64(this.i, true);
    this.i += 8;
    return x;
  }
  utf8(n) {
    if (this.i + n > this.b.length) throw new WireFormatError("Truncated message");
    const s = new TextDecoder("utf-8", { fatal: true }).decode(this.b.subarray(this.i, this.i + n));
    this.i += n;
    return s;
  }
}

// ── String dictionary ───────────────────────────────────────────────────────

function collectStrings(value, add, depth = 0) {
  if (depth > MAX_DEPTH) throw new WireFormatError("Value nested too deeply");
  if (typeof value === "string") add(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, add, depth + 1);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      add(k);
      collectStrings(v, add, depth + 1);
    }
}

function writeValue(w, value, idx, depth = 0) {
  if (depth > MAX_DEPTH) throw new WireFormatError("Value nested too deeply");
  if (value === null || value === undefined) w.byte(TAG.null);
  else if (value === false) w.byte(TAG.false);
  else if (value === true) w.byte(TAG.true);
  else if (typeof value === "number") {
    // -0 is written as 0, as JSON does, so replicas on either transport hold
    // identical state.
    if (Number.isSafeInteger(value)) {
      if (value >= 0) {
        w.byte(TAG.uint);
        w.uint(value);
      } else {
        w.byte(TAG.negint);
        w.uint(-value - 1);
      }
    } else {
      if (!Number.isFinite(value)) throw new WireFormatError("Non-finite numbers are not JSON values");
      w.byte(TAG.float);
      w.float(value);
    }
  } else if (typeof value === "string") {
    w.byte(TAG.string);
    w.uint(idx.get(value));
  } else if (Array.isArray(value)) {
    w.byte(TAG.array);
    w.uint(value.length);
    for (const v of value) writeValue(w, v, idx, depth + 1);
  } else if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    w.byte(TAG.object);
    w.uint(entries.length);
    for (const [k, v] of entries) {
      w.uint(idx.get(k));
      writeValue(w, v, idx, depth + 1);
    }
  } else throw new WireFormatError(`Unsupported value type ${typeof value}`);
}

function readValue(r, dict, depth = 0) {
  if (depth > MAX_DEPTH) throw new WireFormatError("Value nested too deeply");
  const tag = r.byte();
  switch (tag) {
    case TAG.null:
      return null;
    case TAG.false:
      return false;
    case TAG.true:
      return true;
    case TAG.uint:
      return r.uint();
    case TAG.negint:
      return -r.uint() - 1;
    case TAG.float:
      return r.float();
    case TAG.string:
      return str(dict, r.uint());
    case TAG.array: {
      const n = r.uint();
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = readValue(r, dict, depth + 1);
      return out;
    }
    case TAG.object: {
      const n = r.uint();
      const out = {};
      for (let i = 0; i < n; i++) {
        const k = str(dict, r.uint());
        Object.defineProperty(out, k, { value: readValue(r, dict, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    default:
      throw new WireFormatError(`Unknown value tag ${tag}`);
  }
}

function str(dict, i) {
  if (i >= dict.length) throw new WireFormatError("String index out of range");
  return dict[i];
}

// ── Ops and state vectors ───────────────────────────────────────────────────

/** Groups [key, value, deleted, client, clock, lamport] tuples by client, clock ascending. */
function groupByClient(tuples) {
  const groups = new Map();
  for (const t of tuples) {
    let g = groups.get(t[3]);
    if (!g) groups.set(t[3], (g = []));
    g.push(t);
  }
  const out = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [, g] of out) g.sort((a, b) => a[4] - b[4]);
  return out;
}

function writeTuples(w, tuples, idx) {
  const groups = groupByClient(tuples);
  w.uint(groups.length);
  for (const [client, ops] of groups) {
    w.uint(idx.get(client));
    w.uint(ops.length);
    let prevClock = 0;
    let prevLamport = 0;
    for (const [key, value, deleted, , clock, lamport] of ops) {
      w.uint(clock - prevClock);
      w.sint(lamport - prevLamport);
      prevClock = clock;
      prevLamport = lamport;
      w.uint(idx.get(key));
      // flags: bit0 deleted, bit1 has value
      const hasValue = value !== null && value !== undefined;
      w.byte((deleted ? 1 : 0) | (hasValue ? 2 : 0));
      if (hasValue) writeValue(w, value, idx);
    }
  }
}

function readTuples(r, dict) {
  const out = [];
  const groups = r.uint();
  for (let g = 0; g < groups; g++) {
    const client = str(dict, r.uint());
    const n = r.uint();
    let clock = 0;
    let lamport = 0;
    for (let i = 0; i < n; i++) {
      clock += r.uint();
      lamport += r.sint();
      const key = str(dict, r.uint());
      const flags = r.byte();
      const value = flags & 2 ? readValue(r, dict) : null;
      out.push([key, value, flags & 1 ? 1 : 0, client, clock, lamport]);
    }
  }
  return out;
}

function writeVector(w, sv, idx) {
  const entries = Object.entries(sv || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  w.uint(entries.length);
  for (const [client, clock] of entries) {
    w.uint(idx.get(client));
    w.uint(clock);
  }
}

function readVector(r, dict) {
  const n = r.uint();
  const sv = {};
  for (let i = 0; i < n; i++) sv[str(dict, r.uint())] = r.uint();
  return sv;
}

function writeUpdateBody(w, update, idx) {
  w.uint(update.lamport || 0);
  if (update.type === "delta") writeTuples(w, update.ops, idx);
  else if (update.type === "snapshot") {
    writeVector(w, update.sv, idx);
    writeTuples(w, update.entries, idx);
  } else throw new WireFormatError(`Unknown update type "${update.type}"`);
}

function readUpdateBody(r, dict, kind) {
  const lamport = r.uint();
  if (kind === KIND.delta) return { type: "delta", lamport, ops: readTuples(r, dict) };
  const sv = readVector(r, dict);
  return { type: "snapshot", lamport, sv, entries: readTuples(r, dict) };
}

function stringsOfUpdate(update, add) {
  for (const t of update.type === "delta" ? update.ops : update.entries) {
    add(t[0]);
    add(t[3]);
    if (t[1] !== null && t[1] !== undefined) collectStrings(t[1], add);
  }
  if (update.sv) for (const c of Object.keys(update.sv)) add(c);
}

function buildDictionary(collect) {
  const idx = new Map();
  const dict = [];
  collect((s) => {
    if (!idx.has(s)) {
      idx.set(s, dict.length);
      dict.push(s);
    }
  });
  return { idx, dict };
}

function writeHeader(w, kind, dict) {
  w.bytes(MAGIC);
  w.byte(VERSION);
  w.byte(kind);
  const enc = new TextEncoder();
  w.uint(dict.length);
  for (const s of dict) {
    const b = enc.encode(s);
    w.uint(b.length);
    w.bytes(b);
  }
}

function readHeader(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new WireFormatError("Expected a Uint8Array");
  const r = new Reader(bytes);
  for (const m of MAGIC) if (r.byte() !== m) throw new WireFormatError("Not a HelPhone CRDT wire message");
  const version = r.byte();
  if (version !== VERSION) throw new WireFormatError(`Unsupported wire version ${version}`);
  const kind = r.byte();
  if (!Object.values(KIND).includes(kind)) throw new WireFormatError(`Unknown message kind ${kind}`);
  const n = r.uint();
  if (n > bytes.length) throw new WireFormatError("Dictionary larger than the message");
  const dict = new Array(n);
  for (let i = 0; i < n; i++) dict[i] = r.utf8(r.uint());
  return { r, kind, dict };
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Encodes a StateVectorDoc update (`encodeUpdate` / `encodeSnapshot` output). */
export function encodeUpdate(update) {
  const { idx, dict } = buildDictionary((add) => stringsOfUpdate(update, add));
  const w = new Writer();
  writeHeader(w, KIND[update.type], dict);
  writeUpdateBody(w, update, idx);
  return w.result();
}

/** Decodes bytes from `encodeUpdate` back to an update `applyUpdate` accepts. */
export function decodeUpdate(bytes) {
  const { r, kind, dict } = readHeader(bytes);
  if (kind === KIND.gossip) throw new WireFormatError("Expected an update, got a gossip envelope");
  const update = readUpdateBody(r, dict, kind);
  if (r.i !== bytes.length) throw new WireFormatError("Trailing bytes after the update");
  return update;
}

/**
 * Gossip envelope: who sent it, the sender's state vector, the state vectors
 * it knows for other roster members, and the update for the receiver.
 *   { from, sv, roster: { clientId: sv }, update }
 */
export function encodeGossip({ from, sv, roster = {}, update }) {
  const { idx, dict } = buildDictionary((add) => {
    add(from);
    for (const c of Object.keys(sv)) add(c);
    for (const [member, msv] of Object.entries(roster)) {
      add(member);
      for (const c of Object.keys(msv)) add(c);
    }
    stringsOfUpdate(update, add);
  });
  const w = new Writer();
  writeHeader(w, KIND.gossip, dict);
  w.uint(idx.get(from));
  writeVector(w, sv, idx);
  const members = Object.entries(roster).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  w.uint(members.length);
  for (const [member, msv] of members) {
    w.uint(idx.get(member));
    writeVector(w, msv, idx);
  }
  w.byte(KIND[update.type]);
  writeUpdateBody(w, update, idx);
  return w.result();
}

export function decodeGossip(bytes) {
  const { r, kind, dict } = readHeader(bytes);
  if (kind !== KIND.gossip) throw new WireFormatError("Expected a gossip envelope");
  const from = str(dict, r.uint());
  const sv = readVector(r, dict);
  const roster = {};
  const n = r.uint();
  for (let i = 0; i < n; i++) {
    const member = str(dict, r.uint());
    roster[member] = readVector(r, dict);
  }
  const updateKind = r.byte();
  if (updateKind !== KIND.delta && updateKind !== KIND.snapshot) throw new WireFormatError("Bad update kind in gossip");
  const update = readUpdateBody(r, dict, updateKind);
  if (r.i !== bytes.length) throw new WireFormatError("Trailing bytes after the gossip envelope");
  return { from, sv, roster, update };
}
