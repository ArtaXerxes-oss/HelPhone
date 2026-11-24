/**
 * Versioned offline data bundles with per-file integrity (#893).
 *
 * Offline routing graphs (HPGR) and, later, packaged map tiles ship as a
 * bundle: a set of files plus one manifest that names each file's SHA-256
 * and size. A client caches the files keyed by the bundle version, verifies
 * every file against the manifest before using it, and keeps the previous
 * verified version when a newer download fails verification.
 *
 * Manifest shape:
 *   {
 *     format: "helphone-offline-bundle/1",
 *     kind: "routing" | "map-tiles",
 *     zone: "lagos-island",        // incident zone id
 *     version: 3,                  // monotonic per zone
 *     files: [{ path, sha256, bytes, ...kind-specific metadata }],
 *     ...kind-specific fields
 *   }
 *
 * The manifest is serialised canonically (sorted keys, files sorted by
 * path, no timestamps), so the same input always yields byte-identical
 * output and a CI job can rebuild a bundle and compare hashes.
 *
 * Works in browsers, service workers and Node 22 (WebCrypto `crypto.subtle`).
 */

export const BUNDLE_FORMAT = "helphone-offline-bundle/1";
export const BUNDLE_KINDS = Object.freeze(["routing", "map-tiles"]);

const ZONE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export class BundleIntegrityError extends Error {
  /**
   * @param {string} reason machine-readable cause
   * @param {string} message
   * @param {object} [detail]
   */
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "BundleIntegrityError";
    this.reason = reason;
    this.detail = detail;
  }
}

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error("WebCrypto (crypto.subtle) is not available");
  return c.subtle;
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer)
    return new Uint8Array(data).slice();
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === "string") return new TextEncoder().encode(data);
  throw new TypeError("Expected bytes");
}

/** Lower-case hex SHA-256 of bytes or a string. */
export async function sha256Hex(data) {
  const digest = await subtle().digest("SHA-256", toBytes(data));
  let out = "";
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, "0");
  return out;
}

/** JSON with object keys sorted at every level: the form that is hashed and signed. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new TypeError("Non-finite numbers cannot be serialised");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/**
 * Builds a manifest for `files` ({ path, bytes: Uint8Array|ArrayBuffer,
 * meta? }). Hashes every file; output is independent of input order.
 */
export async function createBundleManifest({ kind, zone, version, files, extra = {} }) {
  if (!BUNDLE_KINDS.includes(kind)) throw new RangeError(`Unknown bundle kind "${kind}"`);
  if (!ZONE_RE.test(zone)) throw new RangeError(`Invalid zone id "${zone}"`);
  if (!Number.isSafeInteger(version) || version < 1) throw new RangeError("version must be a positive integer");
  const entries = [];
  const seen = new Set();
  for (const f of files) {
    if (!PATH_RE.test(f.path) || f.path.includes("..")) throw new RangeError(`Invalid bundle path "${f.path}"`);
    if (seen.has(f.path)) throw new RangeError(`Duplicate bundle path "${f.path}"`);
    seen.add(f.path);
    const bytes = toBytes(f.bytes);
    entries.push({ ...(f.meta || {}), path: f.path, sha256: await sha256Hex(bytes), bytes: bytes.byteLength });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ...extra, format: BUNDLE_FORMAT, kind, zone, version, files: entries };
}

/** Structural checks on a parsed manifest. Throws BundleIntegrityError. */
export function validateBundleManifest(manifest, { kind } = {}) {
  const fail = (msg) => {
    throw new BundleIntegrityError("malformed-manifest", msg);
  };
  if (!manifest || typeof manifest !== "object") fail("Manifest is not an object");
  if (manifest.format !== BUNDLE_FORMAT) fail(`Unsupported bundle format "${manifest.format}"`);
  if (kind && manifest.kind !== kind) fail(`Expected a ${kind} bundle, got "${manifest.kind}"`);
  if (!BUNDLE_KINDS.includes(manifest.kind)) fail(`Unknown bundle kind "${manifest.kind}"`);
  if (typeof manifest.zone !== "string" || !ZONE_RE.test(manifest.zone)) fail("Invalid zone id");
  if (!Number.isSafeInteger(manifest.version) || manifest.version < 1) fail("Invalid bundle version");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail("Manifest lists no files");
  const seen = new Set();
  for (const f of manifest.files) {
    if (!f || typeof f.path !== "string" || !PATH_RE.test(f.path) || f.path.includes(".."))
      fail("Invalid file path in manifest");
    if (seen.has(f.path)) fail(`Duplicate file "${f.path}" in manifest`);
    seen.add(f.path);
    if (typeof f.sha256 !== "string" || !SHA256_RE.test(f.sha256)) fail(`Invalid sha256 for "${f.path}"`);
    if (!Number.isSafeInteger(f.bytes) || f.bytes < 0) fail(`Invalid size for "${f.path}"`);
  }
  return manifest;
}

/** The manifest entry for `path`, or undefined. */
export function bundleFile(manifest, path) {
  return manifest.files.find((f) => f.path === path);
}

/**
 * Verifies `data` against its manifest entry (size, then SHA-256) and returns
 * the bytes. Throws BundleIntegrityError("size-mismatch" | "hash-mismatch").
 */
export async function verifyBundleFile(data, entry) {
  const bytes = toBytes(data);
  if (bytes.byteLength !== entry.bytes)
    throw new BundleIntegrityError(
      "size-mismatch",
      `${entry.path}: ${bytes.byteLength} bytes, manifest says ${entry.bytes}`,
      { path: entry.path, expected: entry.bytes, actual: bytes.byteLength },
    );
  const actual = await sha256Hex(bytes);
  if (actual !== entry.sha256)
    throw new BundleIntegrityError("hash-mismatch", `${entry.path}: SHA-256 does not match the manifest`, {
      path: entry.path,
      expected: entry.sha256,
      actual,
    });
  return bytes;
}

// ── Signed manifests (#896) ─────────────────────────────────────────────────
//
// A signed bundle wraps the manifest with an Ed25519 signature over its
// canonical JSON:
//   { manifest, signature: { alg: "Ed25519", keyId, value: base64 } }
// `keyId` is the first 16 hex characters of SHA-256 over the raw 32-byte
// public key. Clients trust only keys compiled into the app; a manifest that
// is unsigned, signed by an unknown key, or altered after signing is refused,
// so a compromised tile host cannot swap both a tile and its hash.

function toBase64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Key id for a raw Ed25519 public key (Uint8Array, 32 bytes). */
export async function bundleKeyId(rawPublicKey) {
  return (await sha256Hex(rawPublicKey)).slice(0, 16);
}

/** Signs a manifest with an Ed25519 CryptoKey (private, "sign" usage). */
export async function signBundleManifest(manifest, privateKey, rawPublicKey) {
  validateBundleManifest(manifest);
  const value = new Uint8Array(
    await subtle().sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(canonicalJson(manifest))),
  );
  return { manifest, signature: { alg: "Ed25519", keyId: await bundleKeyId(rawPublicKey), value: toBase64(value) } };
}

/**
 * Verifies a signed bundle against trusted keys ({ keyId: base64 raw public
 * key }) and returns its manifest. Throws BundleIntegrityError:
 * "unsigned" | "unknown-key" | "bad-signature" | "malformed-manifest".
 */
export async function verifySignedManifest(signed, trustedKeys, { kind } = {}) {
  if (!signed || typeof signed !== "object" || !signed.manifest)
    throw new BundleIntegrityError("malformed-manifest", "Not a signed bundle");
  const sig = signed.signature;
  if (!sig || sig.alg !== "Ed25519" || typeof sig.value !== "string" || typeof sig.keyId !== "string")
    throw new BundleIntegrityError("unsigned", "Bundle manifest is not signed");
  const keyB64 = trustedKeys && Object.prototype.hasOwnProperty.call(trustedKeys, sig.keyId) ? trustedKeys[sig.keyId] : null;
  if (!keyB64) throw new BundleIntegrityError("unknown-key", `Bundle signed by an untrusted key (${sig.keyId})`);
  const raw = fromBase64(keyB64);
  if ((await bundleKeyId(raw)) !== sig.keyId)
    throw new BundleIntegrityError("unknown-key", "Trusted key does not match its key id");
  const key = await subtle().importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  let signature;
  try {
    signature = fromBase64(sig.value);
  } catch {
    throw new BundleIntegrityError("bad-signature", "Signature is not base64");
  }
  const ok = await subtle().verify(
    { name: "Ed25519" },
    key,
    signature,
    new TextEncoder().encode(canonicalJson(signed.manifest)),
  );
  if (!ok) throw new BundleIntegrityError("bad-signature", "Bundle manifest signature does not verify");
  return validateBundleManifest(signed.manifest, { kind });
}

export { toBase64 as _toBase64, fromBase64 as _fromBase64 };
