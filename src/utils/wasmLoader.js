// Spike #602 — isolated WebAssembly sandboxes for encrypted audio vs ZK work.
//
// Each trust domain gets its own instance of src/wasm/memory_sandbox.wasm and
// therefore its own linear memory: a bug in the audio path can only read or
// write audio memory. Moving data between domains is the host's job, done in
// one of two ways:
//
//   "multi-memory"  a ~70-byte bridge module, assembled below, imports both
//                   sandboxes' memories and runs `memory.copy` between them.
//                   The copy stays inside the engine; no JS view is touched.
//   "js-copy"       fallback for engines without multi-memory:
//                   Uint8Array.prototype.set between the two memory buffers.
//
// Both strategies give the same isolation. Only this loader holds references
// to both memories; the sandboxes never do. Multi-memory is purely a
// performance path. See docs/adr/ADR-002-wasm-memory-isolation.md.

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function uleb(n) {
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

const section = (id, bytes) => [id, ...uleb(bytes.length), ...bytes];
const vec = (items) => [...uleb(items.length), ...items.flat()];
const name = (s) => vec([...s].map((c) => [c.charCodeAt(0)]));

/**
 * Bridge module: imports memories `env.a` (index 0) and `env.b` (index 1) and
 * exports `a_to_b(dst, src, len)` / `b_to_a(dst, src, len)`, each a single
 * multi-memory `memory.copy` (0xFC 0x0A dstmem srcmem).
 */
export function buildBridgeModule() {
  const memImport = (field) => [
    ...name("env"),
    ...name(field),
    0x02,
    0x00,
    0x00,
  ];
  const copyBody = (dstMem, srcMem) =>
    vec(
      [
        0x00, // no locals
        0x20,
        0x00, // local.get dst
        0x20,
        0x01, // local.get src
        0x20,
        0x02, // local.get len
        0xfc,
        0x0a,
        dstMem,
        srcMem, // memory.copy dstmem srcmem
        0x0b, // end
      ].map((b) => [b]),
    );
  return Uint8Array.from([
    ...WASM_MAGIC,
    ...section(1, vec([[0x60, 0x03, 0x7f, 0x7f, 0x7f, 0x00]])), // (i32 i32 i32) -> ()
    ...section(2, vec([memImport("a"), memImport("b")])),
    ...section(3, vec([[0x00], [0x00]])),
    ...section(
      7,
      vec([
        [...name("a_to_b"), 0x00, 0x00],
        [...name("b_to_a"), 0x00, 0x01],
      ]),
    ),
    ...section(10, vec([copyBody(1, 0), copyBody(0, 1)])),
  ]);
}

/** Smallest module that is only valid when multi-memory is supported: two memories. */
export const MULTI_MEMORY_PROBE = Uint8Array.from([
  ...WASM_MAGIC,
  ...section(
    5,
    vec([
      [0x00, 0x00],
      [0x00, 0x00],
    ]),
  ),
]);

/** Module using `memory.fill` (bulk-memory proposal), which the bridge also relies on. */
const BULK_MEMORY_PROBE = Uint8Array.from([
  ...WASM_MAGIC,
  ...section(1, vec([[0x60, 0x00, 0x00]])),
  ...section(3, vec([[0x00]])),
  ...section(5, vec([[0x00, 0x01]])),
  ...section(
    10,
    vec([
      vec(
        [0x00, 0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0xfc, 0x0b, 0x00, 0x0b].map(
          (b) => [b],
        ),
      ),
    ]),
  ),
]);

/**
 * Feature detection. Pass a WebAssembly-like object to simulate engines in tests.
 * @returns {{ wasm: boolean, bulkMemory: boolean, multiMemory: boolean, sharedMemory: boolean }}
 */
export function detectFeatures(WA = globalThis.WebAssembly) {
  if (!WA || typeof WA.validate !== "function") {
    return {
      wasm: false,
      bulkMemory: false,
      multiMemory: false,
      sharedMemory: false,
    };
  }
  const safe = (bytes) => {
    try {
      return WA.validate(bytes);
    } catch {
      return false;
    }
  };
  return {
    wasm: true,
    bulkMemory: safe(BULK_MEMORY_PROBE),
    multiMemory: safe(MULTI_MEMORY_PROBE),
    sharedMemory:
      typeof SharedArrayBuffer !== "undefined" &&
      globalThis.crossOriginIsolated === true,
  };
}

export const DEFAULT_SANDBOX_URL = new URL(
  "../wasm/memory_sandbox.wasm",
  import.meta.url,
);

async function compileSandbox(source, WA) {
  if (source instanceof WA.Module) return source;
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source))
    return WA.compile(source);
  const res =
    source instanceof Response
      ? source
      : await fetch(source ?? DEFAULT_SANDBOX_URL);
  if (!res.ok)
    throw new Error(`wasmLoader: failed to fetch sandbox (${res.status})`);
  if (typeof WA.compileStreaming === "function") {
    try {
      return await WA.compileStreaming(res.clone());
    } catch {
      // Wrong MIME type from the host; fall through to buffered compile.
    }
  }
  return WA.compile(await res.arrayBuffer());
}

async function instantiateSandbox(module, label, WA) {
  const instance = await WA.instantiate(module, {});
  const x = instance.exports;
  return {
    label,
    memory: x.memory,
    /** Allocate `len` bytes; throws if the sandbox cannot grow. */
    alloc(len) {
      const ptr = x.sandbox_alloc(len);
      if (ptr === 0 && len !== 0)
        throw new RangeError(`${label}: out of memory allocating ${len} bytes`);
      return ptr;
    },
    /** Copy host bytes into this sandbox; returns the pointer. */
    write(bytes) {
      const ptr = this.alloc(bytes.byteLength);
      new Uint8Array(x.memory.buffer, ptr, bytes.byteLength).set(bytes);
      return ptr;
    },
    /** Copy bytes out of this sandbox (a detached copy, not a live view). */
    read(ptr, len) {
      return new Uint8Array(x.memory.buffer, ptr, len).slice();
    },
    checksum: (ptr, len) => x.sandbox_checksum(ptr, len) >>> 0,
    wipe: (ptr, len) => x.sandbox_wipe(ptr, len),
    reset: () => x.sandbox_reset(),
    exports: x,
  };
}

/**
 * Creates the audio and ZK sandboxes plus the cross-domain transfer function.
 *
 * @param {object} [opts]
 * @param {ArrayBuffer|ArrayBufferView|WebAssembly.Module|Response|string|URL} [opts.source]
 *   memory_sandbox.wasm bytes/module/URL; defaults to the bundled asset.
 * @param {"auto"|"multi-memory"|"js-copy"} [opts.strategy] force a transfer path (benchmarks/tests).
 * @param {typeof WebAssembly} [opts.WebAssembly]
 */
export async function createIsolatedSandboxes(opts = {}) {
  const WA = opts.WebAssembly ?? globalThis.WebAssembly;
  const features = detectFeatures(WA);
  if (!features.wasm) throw new Error("wasmLoader: WebAssembly unavailable");

  const module = await compileSandbox(opts.source, WA);
  const audio = await instantiateSandbox(module, "audio", WA);
  const zk = await instantiateSandbox(module, "zk", WA);

  let strategy = opts.strategy ?? "auto";
  if (strategy === "auto")
    strategy =
      features.multiMemory && features.bulkMemory ? "multi-memory" : "js-copy";
  if (strategy === "multi-memory" && !features.multiMemory) {
    throw new Error(
      "wasmLoader: multi-memory requested but not supported by this engine",
    );
  }

  let bridge = null;
  if (strategy === "multi-memory") {
    const inst = await WA.instantiate(buildBridgeModule(), {
      env: { a: audio.memory, b: zk.memory },
    });
    bridge = (inst.instance ?? inst).exports;
  }

  /**
   * Copy `len` bytes at `srcPtr` in `from` into a fresh allocation in `to`.
   * @returns {number} destination pointer in `to`
   */
  function transfer(from, to, srcPtr, len) {
    if (from === to)
      throw new Error("wasmLoader: transfer requires two different sandboxes");
    const dstPtr = to.alloc(len);
    if (bridge) {
      if (from === audio) bridge.a_to_b(dstPtr, srcPtr, len);
      else bridge.b_to_a(dstPtr, srcPtr, len);
    } else {
      // Re-read .buffer every time: alloc() may have grown (and detached) it.
      new Uint8Array(to.memory.buffer, dstPtr, len).set(
        new Uint8Array(from.memory.buffer, srcPtr, len),
      );
    }
    return dstPtr;
  }

  return { audio, zk, transfer, strategy, features };
}
