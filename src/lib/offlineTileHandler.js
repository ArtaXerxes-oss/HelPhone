/**
 * Service-worker side of off-grid map tile bundles (#896).
 *
 * Serves `/offline-tiles/<zone>/v<version>/<z>/<x>/<y>.<ext>`:
 *
 *  - The zone's signed manifest (`/offline-tiles/<zone>/manifest.json`) is
 *    verified against the trusted Ed25519 keys before any tile is trusted. Only
 *    a manifest that verified is kept, so offline the last good release is
 *    used.
 *  - Tiles are cache-first: a version's tiles are immutable (content-addressed
 *    by the manifest), so a cached, verified tile never needs refetching.
 *  - A tile fetched from the network is checked against the manifest's
 *    SHA-256 and size before it is cached or served. A tampered tile is
 *    rejected, a `TILE_ANOMALY` (`TAMPERED`) is reported, and the same tile from
 *    an earlier verified release is served instead when one is cached.
 *  - `install(zone)` packages a zone for offline use: fetch, verify and cache
 *    every tile of the current release, then drop older releases' caches.
 */

import { BundleIntegrityError, bundleFile, canonicalJson, verifyBundleFile, verifySignedManifest } from "./offlineBundle.js";
import { MAP_TILE_BASE } from "./mapTileBundle.js";

export const TILE_CACHE_PREFIX = "helphone-offline-tiles-";
const META_CACHE = `${TILE_CACHE_PREFIX}meta`;
const CONTENT_TYPES = { pbf: "application/x-protobuf", mvt: "application/vnd.mapbox-vector-tile", png: "image/png", webp: "image/webp", jpg: "image/jpeg" };

export const tileCacheName = (zone, version) => `${TILE_CACHE_PREFIX}${zone}-v${version}`;

export function parseOfflineTileUrl(pathname, base = MAP_TILE_BASE) {
  const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([a-z0-9][a-z0-9-]{0,63})/v(\\d+)/(\\d+)/(\\d+)/(\\d+)\\.(pbf|mvt|png|webp|jpg)$`).exec(pathname);
  if (!m) return null;
  const [, zone, version, z, x, y, ext] = m;
  return { zone, version: Number(version), z: Number(z), x: Number(x), y: Number(y), ext, path: `v${version}/${z}/${x}/${y}.${ext}` };
}

export function createOfflineTileHandler({
  cacheStorage,
  fetchImpl = (...a) => fetch(...a),
  trustedKeys,
  notify = () => {},
  base = MAP_TILE_BASE,
  origin = "",
}) {
  const manifests = new Map(); // zone → verified manifest (in memory)

  const manifestUrl = (zone) => `${origin}${base}/${zone}/manifest.json`;
  const tileUrl = (zone, path) => `${origin}${base}/${zone}/${path}`;

  /** The latest verified manifest for a zone: network first, then the verified copy. */
  async function manifestFor(zone, { refresh = false } = {}) {
    if (!refresh && manifests.has(zone)) return manifests.get(zone);
    const meta = await cacheStorage.open(META_CACHE);
    const key = manifestUrl(zone);
    try {
      const res = await fetchImpl(key, { cache: "no-cache" });
      if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
      const signed = JSON.parse(await res.text());
      const manifest = await verifySignedManifest(signed, trustedKeys, { kind: "map-tiles" });
      if (manifest.zone !== zone) throw new BundleIntegrityError("malformed-manifest", "Manifest is for another zone");
      await meta.put(key, new Response(canonicalJson(signed), { headers: { "content-type": "application/json" } }));
      manifests.set(zone, manifest);
      return manifest;
    } catch (err) {
      if (err instanceof BundleIntegrityError)
        notify({ type: "TILE_ANOMALY", payload: { url: key, reason: "MANIFEST_REJECTED", detail: err.reason } });
      const cached = await meta.match(key);
      if (!cached) throw err;
      const manifest = await verifySignedManifest(JSON.parse(await cached.text()), trustedKeys, { kind: "map-tiles" });
      manifests.set(zone, manifest);
      return manifest;
    }
  }

  /** The same z/x/y from an older verified release, if one is cached. */
  async function olderCopy(parsed) {
    const names = (await cacheStorage.keys()).filter((n) => n.startsWith(`${TILE_CACHE_PREFIX}${parsed.zone}-v`));
    const versions = names
      .map((n) => Number(n.slice(`${TILE_CACHE_PREFIX}${parsed.zone}-v`.length)))
      .filter((v) => Number.isInteger(v) && v !== parsed.version)
      .sort((a, b) => b - a);
    for (const v of versions) {
      const cache = await cacheStorage.open(tileCacheName(parsed.zone, v));
      const hit = await cache.match(tileUrl(parsed.zone, `v${v}/${parsed.z}/${parsed.x}/${parsed.y}.${parsed.ext}`));
      if (hit) return hit;
    }
    return null;
  }

  function tileResponse(bytes, ext, source) {
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": CONTENT_TYPES[ext], "x-helphone-tile-source": source, "cache-control": "no-store" },
    });
  }

  /** Fetches, verifies and caches one tile. Returns the bytes or throws. */
  async function fetchVerified(parsed, entry, cache) {
    const url = tileUrl(parsed.zone, entry.path);
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`tile HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    try {
      await verifyBundleFile(bytes, entry);
    } catch (err) {
      notify({ type: "TILE_ANOMALY", payload: { url, reason: "TAMPERED", detail: err.reason } });
      throw err;
    }
    await cache.put(url, tileResponse(bytes, parsed.ext, "network"));
    return bytes;
  }

  return {
    parse: (pathname) => parseOfflineTileUrl(pathname, base),

    /** Response for an offline tile URL, or null if the URL is not one. */
    async handle(pathname) {
      const parsed = parseOfflineTileUrl(pathname, base);
      if (!parsed) return null;
      let manifest;
      try {
        manifest = await manifestFor(parsed.zone);
      } catch {
        return new Response("offline tile bundle unavailable", { status: 503 });
      }
      if (manifest.version !== parsed.version) {
        // A release we have no verified manifest for (or an old one): older
        // verified copies may still serve it.
        const old = await olderCopy(parsed);
        return old || new Response("tile version not available", { status: 404 });
      }
      const entry = bundleFile(manifest, parsed.path);
      if (!entry) return new Response("tile not in bundle", { status: 404 });
      const cache = await cacheStorage.open(tileCacheName(parsed.zone, parsed.version));
      const cached = await cache.match(tileUrl(parsed.zone, entry.path));
      if (cached) {
        const bytes = new Uint8Array(await cached.arrayBuffer());
        try {
          await verifyBundleFile(bytes, entry);
          return tileResponse(bytes, parsed.ext, "cache");
        } catch {
          await cache.delete(tileUrl(parsed.zone, entry.path));
        }
      }
      try {
        return tileResponse(await fetchVerified(parsed, entry, cache), parsed.ext, "network");
      } catch {
        const old = await olderCopy(parsed);
        if (old) return old;
        return new Response("tile failed verification and no cached copy exists", { status: 502 });
      }
    },

    /**
     * Packages a zone for offline use: verifies and caches every tile of the
     * current release, then deletes older releases. Older releases are kept
     * if any tile fails, so the previous verified map stays usable.
     */
    async install(zone, { onProgress = () => {} } = {}) {
      const manifest = await manifestFor(zone, { refresh: true });
      const cache = await cacheStorage.open(tileCacheName(zone, manifest.version));
      let done = 0;
      const failed = [];
      for (const entry of manifest.files) {
        const parsed = parseOfflineTileUrl(`${base}/${zone}/${entry.path}`, base);
        const have = await cache.match(tileUrl(zone, entry.path));
        if (!have) {
          try {
            await fetchVerified(parsed, entry, cache);
          } catch {
            failed.push(entry.path);
          }
        }
        onProgress({ done: ++done, total: manifest.files.length });
      }
      if (!failed.length) {
        for (const name of await cacheStorage.keys())
          if (name.startsWith(`${TILE_CACHE_PREFIX}${zone}-v`) && name !== tileCacheName(zone, manifest.version))
            await cacheStorage.delete(name);
      }
      return { zone, version: manifest.version, tiles: manifest.files.length, failed };
    },
  };
}
