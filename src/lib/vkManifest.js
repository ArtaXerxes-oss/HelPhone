/**
 * Versioned verification-key (VK) manifest (ISP-051, issues #936 and #937).
 *
 * After a circuit change, every verifier has to accept the same VK. The
 * manifest is the single signed statement of which VK is current, and the PWA
 * checks it before trusting a cached VK:
 *
 *   - `vkVersion` only increases. A VK whose version is older than the manifest,
 *     or whose hash the manifest lists in `supersedes`, is rejected (fail closed).
 *   - A manifest is accepted only if its ECDSA P-256 signature checks out
 *     against the pinned public key. With no key pinned, nothing is accepted.
 *   - Offline use is allowed only until `graceUntil`, the signed expiry. The
 *     client cannot extend that window locally.
 *
 * Browser and Node 20+ share this file. It uses WebCrypto only, so the rotation
 * script (`scripts/vk-rotate.mjs`) signs with the same code the app verifies with.
 */

export const VK_MANIFEST_VERSION = 1;
export const VK_MANIFEST_URL = "/zk-assets/vk-manifest.json";
export const VK_CIRCUIT = "responder_credential";

/**
 * Pinned ECDSA P-256 public key (JWK) for manifest signatures. It stays null
 * until the signing key is provisioned, and verification fails closed while it
 * is null. Set it only from the signing ceremony, never from a server response.
 */
export const VK_MANIFEST_PUBLIC_KEY_JWK = null;

const HASH_RE = /^0x[0-9a-f]{64}$/;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const ECDSA_SIGN = { name: "ECDSA", hash: "SHA-256" };

function getSubtle(subtle) {
  const resolved = subtle ?? globalThis.crypto?.subtle;
  if (!resolved) throw new Error("WebCrypto is unavailable");
  return resolved;
}

function isIsoTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * Validates an untrusted manifest and returns a normalised copy.
 * Throws on any malformed field. Does not verify the signature (see verifyVkManifest).
 */
export function parseVkManifest(input) {
  if (!input || typeof input !== "object") throw new Error("VK manifest must be an object");
  if (input.version !== VK_MANIFEST_VERSION) throw new Error(`Unsupported VK manifest version: ${input.version}`);
  if (typeof input.circuit !== "string" || input.circuit.length === 0) throw new Error("VK manifest circuit missing");
  if (!Number.isSafeInteger(input.vkVersion) || input.vkVersion < 1) throw new Error("VK manifest vkVersion must be a positive integer");
  if (typeof input.vkHash !== "string" || !HASH_RE.test(input.vkHash)) throw new Error("VK manifest vkHash malformed");
  if (!Array.isArray(input.supersedes) || !input.supersedes.every((h) => typeof h === "string" && HASH_RE.test(h))) {
    throw new Error("VK manifest supersedes must be an array of VK hashes");
  }
  if (!isIsoTime(input.issuedAt)) throw new Error("VK manifest issuedAt malformed");
  if (!isIsoTime(input.graceUntil)) throw new Error("VK manifest graceUntil malformed");
  if (Date.parse(input.graceUntil) <= Date.parse(input.issuedAt)) throw new Error("VK manifest graceUntil must be after issuedAt");
  if (input.signature !== undefined && typeof input.signature !== "string") throw new Error("VK manifest signature malformed");

  return {
    version: input.version,
    circuit: input.circuit,
    vkVersion: input.vkVersion,
    vkHash: input.vkHash,
    supersedes: [...input.supersedes],
    issuedAt: input.issuedAt,
    graceUntil: input.graceUntil,
    ...(input.signature !== undefined ? { signature: input.signature } : {}),
  };
}

/** The signed bytes: the manifest fields in a fixed order, without the signature. */
export function canonicalManifestBytes(manifest) {
  const body = JSON.stringify({
    version: manifest.version,
    circuit: manifest.circuit,
    vkVersion: manifest.vkVersion,
    vkHash: manifest.vkHash,
    supersedes: manifest.supersedes,
    issuedAt: manifest.issuedAt,
    graceUntil: manifest.graceUntil,
  });
  return new TextEncoder().encode(body);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Signs an unsigned manifest with an ECDSA P-256 private key (JWK). Used by the rotation script. */
export async function signVkManifest(unsigned, privateKeyJwk, subtle) {
  const parsed = parseVkManifest({ ...unsigned, signature: undefined });
  const key = await getSubtle(subtle).importKey("jwk", privateKeyJwk, ECDSA, false, ["sign"]);
  const sig = await getSubtle(subtle).sign(ECDSA_SIGN, key, canonicalManifestBytes(parsed));
  return { ...parsed, signature: bytesToBase64(new Uint8Array(sig)) };
}

/**
 * True only when the manifest is signed by the pinned key and the signature
 * checks out. Any failure, including no pinned key, returns false.
 */
export async function verifyVkManifest(manifest, publicKeyJwk = VK_MANIFEST_PUBLIC_KEY_JWK, subtle) {
  if (!publicKeyJwk || !manifest || typeof manifest.signature !== "string") return false;
  try {
    const parsed = parseVkManifest(manifest);
    const key = await getSubtle(subtle).importKey("jwk", publicKeyJwk, ECDSA, false, ["verify"]);
    return await getSubtle(subtle).verify(ECDSA_SIGN, key, base64ToBytes(parsed.signature), canonicalManifestBytes(parsed));
  } catch {
    return false;
  }
}

/**
 * Decides whether a held VK may verify proofs, given a verified manifest.
 *
 * @param {object} args
 * @param {object} args.manifest  Verified, parsed manifest.
 * @param {{vkVersion:number, vkHash:string}|null} args.held  VK the client holds.
 * @param {number} args.now       Epoch ms.
 * @param {boolean} args.online   True when the manifest was fetched just now.
 * @returns {{accept: boolean, reason: string, purge: boolean}}
 *   `purge` is true when the held VK is superseded or unknown and its cache
 *   should be deleted.
 */
export function decideVkAcceptance({ manifest, held, now, online }) {
  if (!manifest) return { accept: false, reason: "no-verified-manifest", purge: false };
  if (!held || typeof held.vkHash !== "string" || !HASH_RE.test(held.vkHash)) {
    return { accept: false, reason: "no-held-vk", purge: false };
  }

  if (held.vkHash === manifest.vkHash) {
    if (held.vkVersion !== manifest.vkVersion) {
      return { accept: false, reason: "version-mismatch", purge: true };
    }
    if (online) return { accept: true, reason: "current", purge: false };
    if (now <= Date.parse(manifest.graceUntil)) return { accept: true, reason: "offline-grace", purge: false };
    return { accept: false, reason: "grace-expired", purge: true };
  }

  const superseded = manifest.supersedes.includes(held.vkHash) || held.vkVersion < manifest.vkVersion;
  return { accept: false, reason: superseded ? "superseded" : "unknown-vk", purge: true };
}

/**
 * Fetches the current manifest, verifies it, and decides. Falls back to the
 * cached manifest only when the network fails. A manifest with a bad signature
 * is refused outright and never falls back.
 *
 * @returns {Promise<{accept:boolean, reason:string, purge:boolean, manifest:object|null, online:boolean}>}
 */
export async function negotiateVk({
  fetchImpl = globalThis.fetch,
  url = VK_MANIFEST_URL,
  cachedManifest = null,
  held,
  now = Date.now(),
  publicKeyJwk = VK_MANIFEST_PUBLIC_KEY_JWK,
  subtle,
} = {}) {
  let manifest = null;
  let online = false;

  try {
    const res = await fetchImpl(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    const candidate = parseVkManifest(await res.json());
    if (!(await verifyVkManifest(candidate, publicKeyJwk, subtle))) {
      return { accept: false, reason: "bad-signature", purge: true, manifest: null, online: false };
    }
    manifest = candidate;
    online = true;
  } catch {
    if (cachedManifest && (await verifyVkManifest(cachedManifest, publicKeyJwk, subtle))) {
      manifest = parseVkManifest(cachedManifest);
    }
  }

  if (!manifest) return { accept: false, reason: "no-verified-manifest", purge: false, manifest: null, online: false };
  return { ...decideVkAcceptance({ manifest, held, now, online }), manifest, online };
}
