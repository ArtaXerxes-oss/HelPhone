/**
 * Integrity helpers shared by the sync server route and the client hydration
 * path (#930, #931, #932).
 *
 * Kept free of Node-only and DOM-only imports so the same module runs in the
 * browser, in a worker, and in the server test harness. Hex digests match
 * `node:crypto` createHash('sha256') for the same UTF-8 input, so the server
 * and the client agree on every checksum.
 */

const encoder = new TextEncoder();

/** SHA-256 of a UTF-8 string as lowercase hex, via Web Crypto. */
export async function sha256Hex(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto (crypto.subtle) is unavailable');
  const digest = await subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * True when `value` is a state vector: a plain object mapping actor keys to
 * non-negative safe integers. Anything else is treated as a corrupt checkpoint
 * or a malformed server response.
 */
export function isValidVector(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, counter]) => key.length > 0 && Number.isSafeInteger(counter) && counter >= 0,
  );
}

/** Total of all counters in a state vector. Used as the join "highwater". */
export function sumVector(vector) {
  let total = 0;
  for (const counter of Object.values(vector ?? {})) total += counter;
  return total;
}

/** True when `next` moves at least one counter forward relative to `current`. */
export function vectorAdvances(next, current) {
  return Object.entries(next).some(([key, counter]) => counter > (current[key] ?? 0));
}

/** Stable identity for an operation, matching LwwElementSet.apply's id scheme. */
export function opIdentity(op) {
  return op.instance
    ? `${op.instance}:${op.actor}:${op.counter}`
    : `${op.actor}:${op.counter}`;
}

/**
 * Deterministic, order-independent digest of a Map's visible state. Used as the
 * convergence hash in join receipts: two replicas with the same visible state
 * produce the same digest.
 */
export function stateDigest(map) {
  const keys = [...map.keys()].sort();
  let h = 0x811c9dc5;
  for (const k of keys) {
    const s = k + '=' + JSON.stringify(map.get(k)) + ';';
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16) + ':' + keys.length;
}
