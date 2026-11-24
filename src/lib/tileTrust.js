/**
 * Ed25519 public keys trusted to sign offline map tile bundles (#896).
 *
 * Compiled in at build time from VITE_TILE_SIGNING_KEYS, a JSON object
 * `{ "<keyId>": "<base64 raw public key>" }` printed by
 * `node scripts/package-map-tiles.js --generate-key <path>`. The trust root
 * is never fetched at runtime: a key served by the tile host could be
 * replaced together with the tiles.
 */
function parseKeys(raw) {
  if (!raw) return {};
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const out = {};
    for (const [id, key] of Object.entries(parsed || {}))
      if (/^[0-9a-f]{16}$/.test(id) && typeof key === "string" && /^[A-Za-z0-9+/]{43}=$/.test(key)) out[id] = key;
    return out;
  } catch {
    return {};
  }
}

const env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
export const TRUSTED_TILE_KEYS = Object.freeze(parseKeys(env.VITE_TILE_SIGNING_KEYS));
export { parseKeys as parseTrustedTileKeys };
