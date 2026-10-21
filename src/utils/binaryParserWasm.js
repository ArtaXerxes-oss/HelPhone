/**
 * JS wrapper for the WASM render-path reader (spike, ADR-014)
 * and JS ↔ Rust/WASM telemetry parsing bridge (ISP-032).
 */

import { instrumentWasmMemory, recordParserAlloc } from "../lib/heapForensics.ts";
import {
  FRAME_BYTES,
  FRAME_VERSION,
  KIND_NAME,
  PRIORITY_NAME,
  BinaryParseError,
  parseFrame as jsParseFrame,
  parseBatch as jsParseBatch,
  priorityFor,
} from './binaryParser.js';
import { WasmViewCache } from '../lib/wasmMemory.js';
import { loadVerifiedWasm, WasmIntegrityError } from './wasmLoader.js';

const PAGE = 65536;
const FUNCTIONS = { flatbuffers: "fb_positions", capnp: "capnp_positions" };

async function instantiate(source) {
  if (source instanceof WebAssembly.Module) return WebAssembly.instantiate(source, {});
  if (typeof Response !== "undefined" && (source instanceof Response || source instanceof Promise)) {
    const res = await source;
    if (WebAssembly.instantiateStreaming && res.headers?.get("content-type") === "application/wasm") {
      return (await WebAssembly.instantiateStreaming(res, {})).instance;
    }
    return (await WebAssembly.instantiate(await res.arrayBuffer(), {})).instance;
  }
  return (await WebAssembly.instantiate(source, {})).instance;
}

export async function createWasmPositionReader(source, { initialCapacity = 1024, initialInputBytes = 256 * 1024 } = {}) {
  // Labelled so traces attribute cold-start instantiate to wasm.init (#795).
  const t0 = performance.now();
  const instance = await instantiate(source);
  try {
    performance.measure("wasm.init", { start: t0, end: performance.now() });
  } catch {
    /* measure unsupported */
  }
  const ex = instance.exports;
  // Count linear-memory growth: WASM memory is invisible to heap snapshots (#793).
  const memory = instrumentWasmMemory(ex.memory);
  const heapBase = ex.__heap_base ? ((ex.__heap_base.value + 7) & ~7) : 1024 * 64;

  let outCap = 0;
  let outPtr = heapBase;
  let inPtr = 0;
  let inCap = 0;
  let bytesView = null;
  const positions = { count: 0, capacity: 0, id: null, kind: null, status: null, latE6: null, lngE6: null, headingCdeg: null };

  function layout(cap, inputBytes) {
    outCap = (cap + 3) & ~3;
    inCap = inputBytes;
    inPtr = (outPtr + outCap * 16 + 7) & ~7;
    const need = inPtr + inCap;
    if (need > memory.buffer.byteLength) memory.grow(Math.ceil((need - memory.buffer.byteLength) / PAGE));
    remap();
  }

  function remap() {
    const buf = memory.buffer;
    bytesView = new Uint8Array(buf);
    positions.capacity = outCap;
    positions.id = new Uint32Array(buf, outPtr, outCap);
    positions.latE6 = new Int32Array(buf, outPtr + 4 * outCap, outCap);
    positions.lngE6 = new Int32Array(buf, outPtr + 8 * outCap, outCap);
    positions.headingCdeg = new Uint16Array(buf, outPtr + 12 * outCap, outCap);
    positions.kind = new Uint8Array(buf, outPtr + 14 * outCap, outCap);
    positions.status = new Uint8Array(buf, outPtr + 15 * outCap, outCap);
  }

  layout(initialCapacity, initialInputBytes);

  function readPositions(format, input) {
    const fn = ex[FUNCTIONS[format]];
    if (!fn) throw new Error(`WASM reader supports ${Object.keys(FUNCTIONS).join(", ")}, not "${format}"`);
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input.buffer ?? input, input.byteOffset ?? 0, input.byteLength);
    // Every frame is copied into linear memory; account the copy (#793, #795).
    recordParserAlloc(bytes.length);
    if (bytes.length > inCap) layout(outCap, Math.max(bytes.length, inCap * 2));
    if (bytesView.buffer !== memory.buffer) remap();
    bytesView.set(bytes, inPtr);
    let n = fn(inPtr, bytes.length, outPtr, outCap);
    if (n === -2) {
      layout(Math.max(ex.needed(), outCap * 2), inCap);
      bytesView.set(bytes, inPtr); // layout() moved the input region
      n = fn(inPtr, bytes.length, outPtr, outCap);
    }
    if (n < 0) throw new Error(`WASM ${format} reader rejected the frame (code ${n})`);
    positions.count = n;
    return n;
  }

  return { readPositions, positions, memory };
}

// ===========================================================================
// ISP-032 TelemetryWasmParser
// ===========================================================================

const DEFAULT_WASM_URL = new URL('../wasm/telemetry_reader.wasm', import.meta.url);
const DEFAULT_SHA_URL = new URL('../wasm/telemetry_reader.wasm.sha256', import.meta.url);

const STATUS_TO_CODE = {
  [-1]: 'truncated',
  [-2]: 'bad_magic',
  [-3]: 'bad_version',
  [-4]: 'bad_kind',
  [-5]: 'bad_priority',
  [-6]: 'non_finite',
  [-7]: 'bad_coordinates',
};

function toBytes(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('telemetry parser expects an ArrayBuffer or ArrayBufferView');
}

async function resolveSha({ shaUrl, expectedSha256, fetchImpl }) {
  if (expectedSha256) return String(expectedSha256).trim().toLowerCase();
  if (!shaUrl) return undefined;
  const response = await fetchImpl(shaUrl, { cache: 'force-cache' });
  if (!response.ok) return undefined;
  const text = (await response.text()).trim().split(/\s+/)[0];
  return /^[0-9a-f]{64}$/i.test(text) ? text.toLowerCase() : undefined;
}

export class TelemetryWasmParser {
  constructor(options = {}) {
    this.options = options;
    this.mode = 'js';
    this.lastError = null;
    this.viewCache = new WasmViewCache();
    this.framePool = [];
    this.reusedBatch = [];
    this.ready = false;
    this.initPromise = null;
    this.stats = {
      parsed: 0,
      wasmParsed: 0,
      fallbackParsed: 0,
      errors: 0,
      wasmBatchCalls: 0,
      allocationCount: 0,
      recycledCount: 0,
      objectsCreated: 0,
      viewRefreshes: 0,
    };
  }

  /** Start loading the module without blocking the caller. */
  init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.load().catch((error) => {
      this.lastError = error;
      this.mode = 'js';
      return false;
    });
    return this.initPromise;
  }

  async load() {
    const {
      wasmUrl = DEFAULT_WASM_URL,
      shaUrl = DEFAULT_SHA_URL,
      wasmBytes,
      expectedSha256,
      fetchImpl = globalThis.fetch,
      timeoutMs = 2_000,
      preferWasm = true,
    } = this.options;

    if (!preferWasm || typeof WebAssembly === 'undefined') return false;

    let sha;
    try {
      sha = await resolveSha({ shaUrl, expectedSha256, fetchImpl });
    } catch {
      sha = undefined;
    }

    const loaded = await loadVerifiedWasm({
      url: wasmBytes ? undefined : wasmUrl,
      bytes: wasmBytes,
      expectedSha256: sha,
      fetchImpl,
      timeoutMs,
      imports: {},
    });

    const exports = loaded.exports;
    if (
      typeof exports.parse_batch !== 'function' ||
      typeof exports.input_ptr !== 'function' ||
      typeof exports.input_cap !== 'function' ||
      typeof exports.output_ptr !== 'function' ||
      !(exports.memory instanceof WebAssembly.Memory)
    ) {
      throw new WasmIntegrityError('telemetry_reader.wasm is missing required exports');
    }

    this.exports = exports;
    this.memory = exports.memory;
    this.inputPtr = exports.input_ptr() >>> 0;
    this.outputPtr = exports.output_ptr() >>> 0;
    this.inputCap = exports.input_cap() >>> 0;
    this.outputCap = typeof exports.output_cap === 'function'
      ? exports.output_cap() >>> 0
      : Math.floor(this.inputCap / FRAME_BYTES);
    this.mode = 'wasm';
    this.ready = true;
    this.lastError = null;
    return true;
  }

  /**
   * Parse a single frame, using WASM when ready. `out` is reused when
   * supplied, which is what the main-thread ring consumer does.
   */
  parseFrame(input, offset = 0, out) {
    this.stats.parsed++;
    if (!this.ready) {
      const frame = jsParseFrame(input, offset, out);
      this.stats.fallbackParsed++;
      return frame;
    }

    const bytes = toBytes(input);
    if (offset < 0 || offset + FRAME_BYTES > bytes.byteLength) {
      this.stats.errors++;
      throw new BinaryParseError('truncated', `need ${FRAME_BYTES} bytes at offset ${offset}`);
    }

    const { u8, f64 } = this.viewCache.views(this.memory);
    u8.set(bytes.subarray(offset, offset + FRAME_BYTES), this.inputPtr);

    let status = 0;
    try {
      status = this.exports.parse_frame(FRAME_BYTES) | 0;
    } catch (error) {
      this.stats.errors++;
      this.ready = false;
      this.mode = 'js';
      this.lastError = error;
      return jsParseFrame(input, offset, out);
    }

    if (status !== 0) {
      this.stats.errors++;
      const code = STATUS_TO_CODE[status] || 'parse_error';
      throw new BinaryParseError(code, `wasm parse_frame failed (status ${status})`);
    }

    const base = this.outputPtr / 8;
    const seq = f64[base + 0];
    const ts = f64[base + 1];
    const lat = f64[base + 2];
    const lng = f64[base + 3];
    const accuracy = f64[base + 4];
    const kind = f64[base + 5] | 0;
    const declaredPriority = f64[base + 6] | 0;
    const flags = f64[base + 7] | 0;

    if (!KIND_NAME[kind] || !PRIORITY_NAME[declaredPriority]) {
      this.stats.errors++;
      throw new BinaryParseError('wasm_output', 'wasm parser returned an unknown kind/priority');
    }

    const frame = out || {};
    frame.magic = 0x48454c50;
    frame.version = FRAME_VERSION;
    frame.kind = kind;
    frame.kindName = KIND_NAME[kind];
    frame.priority = priorityFor(kind, declaredPriority, flags);
    frame.flags = flags;
    frame.seq = seq;
    frame.ts = ts;
    frame.lat = lat;
    frame.lng = lng;
    frame.accuracy = accuracy;
    frame.bytes = FRAME_BYTES;
    this.stats.wasmParsed++;
    this.stats.viewRefreshes = this.viewCache.refreshCount;
    return frame;
  }

  parseBatch(input, count, options = {}) {
    if (!this.ready) {
      this.stats.fallbackParsed += count ?? 0;
      return jsParseBatch(input, count, options);
    }
    const bytes = toBytes(input);
    const total = count ?? Math.floor(bytes.byteLength / FRAME_BYTES);
    const reuse = options.reuse === true;
    const out = options.reuseArray === true ? this.reusedBatch : [];
    if (options.reuseArray === true) out.length = 0;
    const chunkFrames = Math.max(1, Math.min(this.outputCap, Math.floor(this.inputCap / FRAME_BYTES)));

    for (let start = 0; start < total; start += chunkFrames) {
      const frames = Math.min(chunkFrames, total - start);
      const byteStart = start * FRAME_BYTES;
      const byteLength = frames * FRAME_BYTES;
      const { u8, f64 } = this.viewCache.views(this.memory);
      u8.set(bytes.subarray(byteStart, byteStart + byteLength), this.inputPtr);

      let parsed;
      try {
        parsed = this.exports.parse_batch(byteLength, frames) | 0;
        this.stats.wasmBatchCalls++;
      } catch (error) {
        this.stats.errors++;
        this.ready = false;
        this.mode = 'js';
        this.lastError = error;
        this.stats.fallbackParsed += total - start;
        return out.concat(jsParseBatch(bytes.subarray(byteStart), total - start, options));
      }

      if (parsed !== frames) {
        this.stats.errors++;
        this.stats.fallbackParsed += frames;
        const fallback = jsParseBatch(bytes.subarray(byteStart, byteStart + byteLength), frames, options);
        if (options.stopOnError !== false) {
          const bad = fallback.find((frame) => frame?.error);
          if (bad) throw new BinaryParseError(bad.error, `invalid frame at index ${start + bad.index}`);
        }
        out.push(...fallback);
        continue;
      }

      const base = this.outputPtr / 8;
      for (let i = 0; i < frames; i++) {
        const offset = base + i * 8;
        const kind = f64[offset + 5] | 0;
        const declaredPriority = f64[offset + 6] | 0;
        const flags = f64[offset + 7] | 0;
        let frame;
        if (reuse) {
          const poolIndex = start + i;
          frame = this.framePool[poolIndex];
          if (frame) this.stats.recycledCount++;
          else {
            frame = this.framePool[poolIndex] = {};
            this.stats.objectsCreated++;
          }
        } else {
          frame = {};
          this.stats.objectsCreated++;
        }
        frame.magic = 0x48454c50;
        frame.version = FRAME_VERSION;
        frame.kind = kind;
        frame.kindName = KIND_NAME[kind];
        frame.priority = priorityFor(kind, declaredPriority, flags);
        frame.flags = flags;
        frame.seq = f64[offset + 0];
        frame.ts = f64[offset + 1];
        frame.lat = f64[offset + 2];
        frame.lng = f64[offset + 3];
        frame.accuracy = f64[offset + 4];
        frame.bytes = FRAME_BYTES;
        out.push(frame);
      }
      this.stats.wasmParsed += parsed;
    }
    return out;
  }

  getStats() {
    return {
      ...this.stats,
      mode: this.mode,
      ready: this.ready,
      lastError: this.lastError ? String(this.lastError.message || this.lastError) : null,
    };
  }
}

let sharedParser = null;

/** Lazily shared parser for the main thread. */
export function getTelemetryParser(options) {
  if (!sharedParser || options) sharedParser = new TelemetryWasmParser(options);
  return sharedParser;
}

export function resetTelemetryParser() {
  sharedParser = null;
}

export default TelemetryWasmParser;
