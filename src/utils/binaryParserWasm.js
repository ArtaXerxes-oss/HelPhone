/**
 * JS wrapper for the WASM render-path reader (spike, ADR-014).
 *
 * The module (src/wasm/telemetry_reader.wasm, built from
 * src/wasm/telemetry_reader/) exposes the same operation as
 * readPositions("flatbuffers" | "capnp", ...) in binaryParser.js. The
 * difference is where the bytes live: WASM can only read its own linear
 * memory, so every frame is first copied in. A network ArrayBuffer cannot
 * be handed to WASM without that copy (wasm memory cannot adopt or be
 * transferred an existing buffer), and the ADR measures what it costs.
 *
 * Output arrays are views over WASM memory, so JS reads them without a copy.
 * They are re-created whenever memory grows, so re-read `reader.positions`
 * after each call instead of holding on to the arrays.
 *
 *   const reader = await createWasmPositionReader(wasmBytesOrResponse);
 *   const n = reader.readPositions("flatbuffers", frameBytes);
 *   reader.positions.latE6[0];
 */

import { instrumentWasmMemory, recordParserAlloc } from "../lib/heapForensics.ts";

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
  const heapBase = (ex.__heap_base.value + 7) & ~7;

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
