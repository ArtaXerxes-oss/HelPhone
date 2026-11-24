// Spike #602 — isolated WebAssembly sandboxes for encrypted audio vs ZK work
// and Verified WASM loader (ISP-032).

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
    alloc(len) {
      const ptr = x.sandbox_alloc(len);
      if (ptr === 0 && len !== 0)
        throw new RangeError(`${label}: out of memory allocating ${len} bytes`);
      return ptr;
    },
    write(bytes) {
      const ptr = this.alloc(bytes.byteLength);
      new Uint8Array(x.memory.buffer, ptr, bytes.byteLength).set(bytes);
      return ptr;
    },
    read(ptr, len) {
      return new Uint8Array(x.memory.buffer, ptr, len).slice();
    },
    checksum: (ptr, len) => x.sandbox_checksum(ptr, len) >>> 0,
    wipe: (ptr, len) => x.sandbox_wipe(ptr, len),
    reset: () => x.sandbox_reset(),
    exports: x,
  };
}

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

  function transfer(from, to, srcPtr, len) {
    if (from === to)
      throw new Error("wasmLoader: transfer requires two different sandboxes");
    const dstPtr = to.alloc(len);
    if (bridge) {
      if (from === audio) bridge.a_to_b(dstPtr, srcPtr, len);
      else bridge.b_to_a(dstPtr, srcPtr, len);
    } else {
      new Uint8Array(to.memory.buffer, dstPtr, len).set(
        new Uint8Array(from.memory.buffer, srcPtr, len),
      );
    }
    return dstPtr;
  }

  return { audio, zk, transfer, strategy, features };
}

// ===========================================================================
// ISP-032 Verified WASM Loader
// ===========================================================================

const cache = new Map();

export class WasmIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WasmIntegrityError';
  }
}

export class WasmLoadTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WasmLoadTimeoutError';
  }
}

function toBytes(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof Uint8Array) return input;
  throw new TypeError('sha256Hex expects bytes');
}

export async function sha256Hex(input) {
  const bytes = toBytes(input);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

async function fetchBytes(url, fetchImpl, timeoutMs) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(url, { signal: controller?.signal, cache: 'force-cache' });
    if (!response.ok) throw new Error(`fetch ${url} failed: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error?.name === 'AbortError') throw new WasmLoadTimeoutError(`timed out loading ${url}`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function loadVerifiedWasm({
  url,
  bytes,
  expectedSha256,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2_000,
  cache: useCache = true,
  imports = {},
} = {}) {
  const key = url || (bytes ? `inline:${bytes.byteLength}` : '');
  if (!key) return Promise.reject(new TypeError('loadVerifiedWasm requires url or bytes'));
  if (useCache && cache.has(key)) return cache.get(key);

  const promise = (async () => {
    const raw = bytes ? toBytes(bytes) : await fetchBytes(url, fetchImpl, timeoutMs);
    if (expectedSha256) {
      const actual = await sha256Hex(raw);
      if (actual !== String(expectedSha256).trim().toLowerCase()) {
        throw new WasmIntegrityError(
          `WASM integrity mismatch for ${key}: expected ${expectedSha256}, got ${actual}`,
        );
      }
    }
    const { instance, module } = await WebAssembly.instantiate(raw, imports);
    return { instance, module, exports: instance.exports, bytes: raw, verified: Boolean(expectedSha256) };
  })();

  if (useCache) {
    cache.set(key, promise);
    promise.catch(() => cache.delete(key));
  }
  return promise;
}

export function resetWasmLoaderCache() {
  cache.clear();
}

export default { loadVerifiedWasm, sha256Hex, resetWasmLoaderCache };
