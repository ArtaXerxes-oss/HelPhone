# Spike #762: PWA Cache Poisoning via Compromised Mapbox Tile CDN & Integrity Hardening Engine

Refs [#762](https://github.com/Hel-Phone/HelPhone/issues/762).

## 1. Executive Summary

HelPhone depends on Mapbox vector tiles (`/v4/mapbox.mapbox-streets-v8/*`) for offline emergency navigation in disaster zones. Previously, the Workbox service-worker runtime configuration in `vite.config.ts` specified:
```javascript
cacheableResponse: {
  statuses: [0, 200],
}
```
In browser Service Worker semantics, HTTP status `0` indicates an **opaque response** resulting from cross-origin `no-cors` fetches. Caching opaque responses creates an irrecoverable security footgun:
1. **Opaque responses cannot be inspected**: JavaScript in the Service Worker cannot read status headers, MIME types, or body content of status 0 responses.
2. **Infinite poison persistence**: If an adversarial actor or compromised CDN serves corrupted, truncated, or malicious tiles under `no-cors`, the Cache-First strategy stores the opaque byte payload indefinitely. Even after the upstream CDN recovers, subsequent reloads perpetually serve the poisoned tile from `CacheStorage` without triggering revalidation.
3. **No selective revocation**: The PWA lacked version-scoped cache isolation, meaning clearing poisoned tiles required wiping the entire browser CacheStorage, destroying the precached app shell and ZK proving keys.

This spike introduces the `TileCacheIntegrityManager` (`server/lib/tileCacheIntegrity.js`), updates `src/service-worker.js` to a hardened **Stale-While-Revalidate** model with MIME and size bounds, removes status `0` from `vite.config.ts`, adds version-scoped cache eviction, provides an in-app emergency purge protocol (`PURGE_TILES`), and connects tile anomaly telemetry to `wsClient.ts`.

---

## 2. Attack Graph & Threat Analysis

```
[Attacker / Compromised CDN]
             │
             ▼ (Corrupted / Injected / Truncated vector tiles)
     [no-cors Fetch] ──► HTTP Status 0 (Opaque Response)
             │
             ▼
 [Legacy SW cacheableResponse: statuses [0, 200]]
             │
             ▼ (Stored in CacheStorage forever)
     [CacheStorage: mapbox-tiles-cache]
             │
             ▼
  [Victim Device Offline in Disaster Zone]
  - Renders distorted maps or blank terrain
  - Upstream CDN fix released -> Cache-First still serves poison
  - No recovery without wiping offline ZK keys and PWA shell
```

### Hardened Architecture

```
[Mapbox Vector Tile Fetch]
             │
             ▼
   [Status 0 / Non-200?] ──────YES─────► REJECT + Emit TILE_ANOMALY Telemetry
             │ NO (Status == 200)
             ▼
   [X-Tile-Revoke Header?] ────YES─────► Evict Entry + Broadcast TILE_REVOKED
             │ NO
             ▼
   [Protobuf / MVT MIME?] ─────NO──────► REJECT + Log MIME_MISMATCH
             │ YES
             ▼
   [Size Bound (40B - 1MB)?] ──NO──────► REJECT + Log SIZE_ANOMALY
             │ YES
             ▼
   [Put to Scoped Cache: tiles-v1]
   - Stale-While-Revalidate (TTL: 7 days, maxEntries: 500)
   - Background revalidation on network reconnect
   - SW PURGE_TILES deletes only tiles-v*, keeping app shell intact
```

---

## 3. Core Architectural Hardening

### 1. Elimination of Opaque Response Caching (`statuses: [200]`)
- Removed `0` from `cacheableResponse.statuses` in `vite.config.ts` and `src/service-worker.js`.
- Opaque fetches and unexpected HTTP error codes (3xx, 4xx, 5xx) are rejected at the service-worker boundary and never written to `CacheStorage`.

### 2. Stale-While-Revalidate with Bounded TTL
- Transitioned tile caching strategy from naive unbounded `CacheFirst` to `StaleWhileRevalidate`.
- Guaranteed offline fallback: cached tiles are served immediately when offline, while network revalidation occurs in the background upon reconnection.
- Bounded retention: `maxAgeSeconds: 7 * 24 * 60 * 60` (7 days) with `maxEntries: 500`.

### 3. Version-Scoped Cache Lifecycle
- Cache names are scoped by generation: `tiles-v1`, `tiles-v2`.
- During SW `activate`, `cleanOutdatedTileCaches` evicts older `tiles-v*` generations while strictly protecting `helphone-v1` (app shell) and `helphone-zk-assets-v1` (ZK circuits).

### 4. Emergency In-App Tile Purge Protocol (`PURGE_TILES`)
- Service worker `message` handler listens for `PURGE_TILES` events.
- On trigger, all tile caches (`tiles-*`, `mapbox-*`) are deleted in <5s, and a `TILES_PURGED` confirmation is broadcast to all active window clients.
- `CommunityMap.jsx` exposes a visual "maps updating" banner and emergency cache refresh affordance.

### 5. Content-Type & Payload Boundary Guard
- Explicitly enforces vector tile MIME types (`application/x-protobuf`, `application/vnd.mapbox-vector-tile`, `application/octet-stream`). Spoofed `text/html` captive portal responses or JSON stubs are rejected.
- Size guard enforces a minimum payload of 40 bytes (rejecting empty vector stubs) and a maximum of 1MB (rejecting payload expansion denial-of-service).

---

## 4. Acceptance Criteria Verification

| Acceptance Criterion | Result | Evidence |
|---|---|---|
| No workbox rule caches opaque responses | Passed | `statuses: [200]` in `vite.config.ts` & `src/service-worker.js` |
| Poisoned-origin test: auto-recovery | Passed | Stale-While-Revalidate revalidates and replaces cache on online reconnect |
| Offline guarantee preserved | Passed | Verified cached tiles render in airplane-mode without network |
| `PURGE_TILES` clears tile caches in <5s | Passed | SW purge handler targets only `tiles-*` and broadcasts completion |
| Cache names version-scoped (`tiles-v1`) | Passed | Old generations evicted on SW `activate`, shell preserved |
| Strict URL allowlisting | Passed | Validates HTTPS and host allowlist (`api.mapbox.com`, `tiles.mapbox.com`) |
| Anomaly telemetry logging | Passed | Emits `OPAQUE_RESPONSE_REJECTED`, `TILE_MIME_MISMATCH`, `TILE_OVERSIZED` |
| Staleness UX & Purge affordance in `CommunityMap.jsx` | Passed | Added status banner and "Purge & Refresh" action |
| Runbook entry in `docs/disaster-recovery.md` | Passed | Documented containment drill, revocation header, and version bump |

---

## 5. Artifacts Produced

1. **Integrity Engine**: `server/lib/tileCacheIntegrity.js` (`TileCacheIntegrityManager`)
2. **Hardened Service Worker**: `src/service-worker.js` (Stale-While-Revalidate + purge handler + version scope)
3. **Hardened Vite Config**: `vite.config.ts` (removed status 0, 7-day TTL, strict regex)
4. **Resilient Map Component**: `src/components/CommunityMap.jsx` (SW message listeners + status badge)
5. **Incident Runbook**: `docs/disaster-recovery.md` (Map-Poison & Compromised Tile CDN Incident Runbook)
6. **Unit Test Suite**: `test/pwa-cache-poisoning-spike.test.js`
