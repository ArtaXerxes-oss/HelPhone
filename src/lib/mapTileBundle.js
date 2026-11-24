/**
 * Off-grid map tile bundles for an incident zone (#896, ADR-004).
 *
 * A map tile bundle is an offline bundle (offlineBundle.js) of kind
 * "map-tiles": every `z/x/y` tile that covers the zone's bounding box between
 * `minZoom` and `maxZoom`, listed with its SHA-256 in a manifest that is
 * signed with an Ed25519 key. It shares versioning with the routing tiles of
 * #893: files live under `<zone>/v<version>/`, so each release is cached
 * separately and a client only switches once the new release verifies.
 */

import { createBundleManifest } from "./offlineBundle.js";

export const MAP_TILE_BASE = "/offline-tiles";
export const MAX_BUNDLE_TILES = 20_000;
const EXT_RE = /^(pbf|mvt|png|webp|jpg)$/;

/** Slippy-map tile x/y containing (lng, lat) at zoom z. */
export function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clampedLat * Math.PI) / 180;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}

/**
 * Every tile covering bbox [west, south, east, north] for zooms
 * minZoom..maxZoom, in (z, x, y) order.
 */
export function tilesForBbox(bbox, minZoom, maxZoom) {
  const [west, south, east, north] = bbox;
  if (!(west < east && south < north)) throw new RangeError("bbox must be [west, south, east, north]");
  if (!(Number.isInteger(minZoom) && Number.isInteger(maxZoom) && minZoom >= 0 && minZoom <= maxZoom && maxZoom <= 22))
    throw new RangeError("zooms must satisfy 0 <= minZoom <= maxZoom <= 22");
  const out = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const [x0, y0] = lngLatToTile(west, north, z);
    const [x1, y1] = lngLatToTile(east, south, z);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        out.push([z, x, y]);
        if (out.length > MAX_BUNDLE_TILES) throw new RangeError(`Zone needs more than ${MAX_BUNDLE_TILES} tiles; lower maxZoom`);
      }
  }
  return out;
}

export const tilePath = (version, z, x, y, ext) => `v${version}/${z}/${x}/${y}.${ext}`;

/**
 * Builds the manifest for a map tile bundle.
 * @param {object} options
 * @param {(z, x, y) => Promise<Uint8Array|null>} options.readTile tile bytes,
 *   or null where the source has no tile (ocean, outside coverage)
 * @returns {Promise<{ manifest: object, files: Array<{ path: string, bytes: Uint8Array }>, missing: number }>}
 */
export async function buildMapTileBundle({ zone, version, bbox, minZoom, maxZoom, ext = "pbf", readTile }) {
  if (!EXT_RE.test(ext)) throw new RangeError(`Unsupported tile extension "${ext}"`);
  const files = [];
  let missing = 0;
  for (const [z, x, y] of tilesForBbox(bbox, minZoom, maxZoom)) {
    const bytes = await readTile(z, x, y);
    if (!bytes) {
      missing++;
      continue;
    }
    files.push({ path: tilePath(version, z, x, y, ext), bytes, meta: { z, x, y } });
  }
  if (!files.length) throw new Error("No tiles found for the zone");
  const manifest = await createBundleManifest({
    kind: "map-tiles",
    zone,
    version,
    files,
    extra: {
      bbox,
      minZoom,
      maxZoom,
      ext,
      tileUrlTemplate: `${MAP_TILE_BASE}/${zone}/v${version}/{z}/{x}/{y}.${ext}`,
    },
  });
  return { manifest, files: files.map(({ path, bytes }) => ({ path, bytes })), missing };
}
