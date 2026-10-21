/**
 * Verified WASM loader.
 *
 * Integrity is checked off the hot path: callers start with the JS parser and
 * swap to WASM when (and only if) the module has been fetched, hashed, and
 * instantiated. A corrupt/missing module never blocks frame processing.
 */

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

/**
 * Load + verify + instantiate a WASM module.
 *
 * @param {object} options
 * @param {string} [options.url] URL to fetch (browser/worker).
 * @param {ArrayBuffer|Uint8Array} [options.bytes] Inline bytes (Node/tests).
 * @param {string} [options.expectedSha256] Lowercase hex digest from the sidecar.
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.cache]
 * @param {WebAssembly.Imports} [options.imports]
 */
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
