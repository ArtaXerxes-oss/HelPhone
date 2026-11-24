/**
 * Offline routing client for the Help page (#893, ADR-006).
 *
 * Loads a zone's HPGR routing tile, verifies it against its bundle manifest,
 * hands it to `routingWorker` and answers route queries with no network:
 *
 *   const router = createOfflineRouter({ createWorker });
 *   const zones = await router.listZones();          // from /routing-tiles/index.json
 *   await router.loadZone("lagos-island");
 *   const route = await router.route([6.45, 3.39], [6.46, 3.40]);
 *
 * Caching and versioning:
 *   - The manifest is fetched network-first. Only a manifest whose tile has
 *     verified is cached, so offline the last good release is used.
 *   - Tiles are cached under their versioned path (`<zone>.v<n>.hpgr`), so a
 *     cached tile is never confused with a newer one.
 *   - Every tile is verified (size, SHA-256, HPGR header) before it reaches
 *     the worker, whether it came from the network or the cache. A cached tile
 *     that fails is deleted; a newer manifest whose tile fails verification is
 *     ignored and the last verified version stays in use.
 */

import { BundleIntegrityError, canonicalJson } from "./offlineBundle.js";
import { routingTileEntry, verifyRoutingTile } from "./routingTiles.js";

export const ROUTING_TILE_BASE = "/routing-tiles";
export const ROUTING_CACHE_NAME = "helphone-routing-tiles-v1";

const manifestUrl = (base, zone) => `${base}/${zone}.manifest.json`;

/** Request/response correlation over a Worker-like object. */
export function createWorkerClient(worker, { timeoutMs = 30000 } = {}) {
  let next = 1;
  const pending = new Map();
  worker.onmessage = (event) => {
    const msg = event.data || {};
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.type === "error") entry.reject(new Error(msg.message));
    else entry.resolve(msg);
  };
  return {
    request(message, transfer = []) {
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Routing worker did not answer "${message.type}"`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ ...message, id }, transfer);
      });
    },
    terminate() {
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(new Error("Routing worker terminated"));
      }
      pending.clear();
      if (typeof worker.terminate === "function") worker.terminate();
    },
  };
}

export function defaultCreateWorker() {
  return new Worker(new URL("../workers/routingWorker.js", import.meta.url), { type: "module" });
}

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {CacheStorage|null} [options.cacheStorage] null disables caching
 * @param {() => Worker} [options.createWorker]
 * @param {(event: object) => void} [options.onEvent] status/integrity events
 */
export function createOfflineRouter({
  baseUrl = ROUTING_TILE_BASE,
  fetchImpl = (...a) => globalThis.fetch(...a),
  cacheStorage = typeof caches !== "undefined" ? caches : null,
  createWorker = defaultCreateWorker,
  onEvent = () => {},
} = {}) {
  let client = null;
  let loaded = null; // { zone, version, manifest, nodeCount, edgeCount, weighting }
  const emit = (e) => {
    try {
      onEvent(e);
    } catch {
      // a listener must not break routing
    }
  };
  const openCache = async () => (cacheStorage ? cacheStorage.open(ROUTING_CACHE_NAME) : null);

  /** Small JSON documents (the zone index): network first, cache fallback. */
  async function fetchJsonNetworkFirst(url) {
    const cache = await openCache();
    try {
      const res = await fetchImpl(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const text = await res.text();
      const json = JSON.parse(text);
      if (cache) await cache.put(url, new Response(text, { headers: { "content-type": "application/json" } }));
      return { json, source: "network" };
    } catch (err) {
      const cached = cache ? await cache.match(url) : null;
      if (!cached) throw err;
      return { json: JSON.parse(await cached.text()), source: "cache" };
    }
  }

  /** A verified tile for `manifest`, from the cache or the network. */
  async function verifiedTile(manifest) {
    const entry = routingTileEntry(manifest);
    const url = `${baseUrl}/${entry.path}`;
    const cache = await openCache();
    const cached = cache ? await cache.match(url) : null;
    if (cached) {
      try {
        const v = await verifyRoutingTile(await cached.arrayBuffer(), manifest);
        return { ...v, source: "cache" };
      } catch (err) {
        emit({ type: "tile-rejected", source: "cache", zone: manifest.zone, version: manifest.version, reason: err.reason || "error" });
        await cache.delete(url);
      }
    }
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const v = await verifyRoutingTile(bytes, manifest);
    if (cache) await cache.put(url, new Response(bytes, { headers: { "content-type": "application/octet-stream" } }));
    return { ...v, source: "network" };
  }

  async function ensureClient() {
    if (!client) client = createWorkerClient(createWorker());
    return client;
  }

  return {
    /** Zones listed in `<base>/index.json` ([] when none are installed). */
    async listZones() {
      try {
        const { json } = await fetchJsonNetworkFirst(`${baseUrl}/index.json`);
        return Array.isArray(json.zones) ? json.zones.filter((z) => typeof z === "object" && typeof z.zone === "string") : [];
      } catch {
        return [];
      }
    },

    /**
     * Loads (or refreshes) a zone. Resolves with the loaded tile's metadata.
     *
     * Tries the network manifest first, then the last manifest whose tile
     * verified (kept in the cache only after verification, so a bad release
     * can never replace it). If a newer release fails verification, the last
     * verified tile is used and `stale: true` is reported.
     */
    async loadZone(zone) {
      const url = manifestUrl(baseUrl, zone);
      const verifiedKey = `${url}?verified`;
      const cache = await openCache();
      const candidates = [];
      try {
        const res = await fetchImpl(url, { cache: "no-cache" });
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        candidates.push({ manifest: JSON.parse(await res.text()), source: "network" });
      } catch (err) {
        emit({ type: "manifest-unavailable", zone, message: err.message });
      }
      const cachedVerified = cache ? await cache.match(verifiedKey) : null;
      if (cachedVerified) {
        try {
          const manifest = JSON.parse(await cachedVerified.text());
          if (!candidates.length || canonicalJson(candidates[0].manifest) !== canonicalJson(manifest))
            candidates.push({ manifest, source: "cache" });
        } catch {
          await cache.delete(verifiedKey);
        }
      }

      let lastError = new Error(`No routing tiles available for zone "${zone}"`);
      let networkRejected = false;
      for (const { manifest, source } of candidates) {
        try {
          routingTileEntry(manifest);
          if (manifest.zone !== zone)
            throw new BundleIntegrityError("malformed-manifest", `Manifest is for zone "${manifest.zone}", not "${zone}"`);
          if (loaded && loaded.zone === zone && canonicalJson(loaded.manifest) === canonicalJson(manifest))
            return { ...loaded, manifestSource: source, unchanged: true, stale: networkRejected };
          const tile = await verifiedTile(manifest);
          if (cache)
            await cache.put(verifiedKey, new Response(canonicalJson(manifest), { headers: { "content-type": "application/json" } }));
          const worker = await ensureClient();
          const ok = await worker.request({ type: "load", graph: tile.buffer }, [tile.buffer]);
          loaded = {
            zone,
            version: manifest.version,
            manifest,
            nodeCount: ok.nodeCount,
            edgeCount: ok.edgeCount,
            weighting: ok.weighting,
            destinations: Array.isArray(manifest.destinations) ? manifest.destinations : [],
            tileSource: tile.source,
          };
          emit({ type: "zone-loaded", zone, version: manifest.version, tileSource: tile.source, manifestSource: source });
          return { ...loaded, manifestSource: source, stale: networkRejected };
        } catch (err) {
          lastError = err;
          if (source === "network") networkRejected = true;
          emit({ type: "tile-rejected", source, zone, version: manifest && manifest.version, reason: err.reason || "error", message: err.message });
        }
      }
      if (loaded && loaded.zone === zone) return { ...loaded, stale: true, error: lastError.message };
      throw lastError;
    },

    /** Route between two [lat, lng] points over the loaded zone. */
    async route(from, to, { algorithm = "astar" } = {}) {
      if (!loaded) throw new Error("No offline routing zone loaded");
      const worker = await ensureClient();
      const r = await worker.request({ type: "routeLatLng", from, to, algorithm });
      return {
        zone: loaded.zone,
        version: loaded.version,
        reachable: Number.isFinite(r.distance),
        weighting: r.weighting,
        durationS: r.durationS,
        cost: r.distance,
        pathLengthM: r.pathLengthM,
        coordinates: r.coordinates,
        snapped: r.snapped,
        elapsedMs: r.elapsedMs,
      };
    },

    get loaded() {
      return loaded;
    },

    dispose() {
      if (client) client.terminate();
      client = null;
      loaded = null;
    },
  };
}
