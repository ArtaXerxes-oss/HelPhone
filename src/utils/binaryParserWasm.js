/**
 * JS ↔ Rust/WASM telemetry parsing bridge.
 *
 * Hot path properties:
 *  - One fixed staging buffer inside WASM; no Vec allocation per frame.
 *  - Views over WASM linear memory are cached and invalidated when the
 *    memory grows (use-after-grow safety).
 *  - The JS parser is always available, so a missing/corrupt module degrades
 *    gracefully instead of blocking ingestion.
 */

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
    // Manual 40-byte copy: no subarray allocation on the hot path.
    for (let i = 0; i < FRAME_BYTES; i++) u8[this.inputPtr + i] = bytes[offset + i];

    let status;
    try {
      status = this.exports.parse_frame(FRAME_BYTES) | 0;
    } catch (error) {
      this.stats.errors++;
      // A trap means the module is unusable; fall back permanently.
      this.ready = false;
      this.mode = 'js';
      this.lastError = error;
      return jsParseFrame(input, offset, out);
    }

    if (status !== 0) {
      this.stats.errors++;
      throw new BinaryParseError(STATUS_TO_CODE[status] || 'wasm_reject', `wasm parser rejected frame (${status})`);
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
        // One invalid frame invalidates the batch result (Rust stops at the
        // first error). Re-parse this chunk with JS so callers get per-frame
        // error objects rather than losing the whole batch.
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
