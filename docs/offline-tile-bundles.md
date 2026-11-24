# Offline tile bundles

HelPhone ships two kinds of offline data for an incident zone in one bundle format:

| Kind | What | Built by | Read by |
|---|---|---|---|
| `routing` | One HPGR road graph (#893, ADR-006) | `scripts/build-routing-tiles.js` | `src/lib/offlineRouting.js` → `routingWorker` |
| `map-tiles` | Every `z/x/y` map tile covering the zone (#896, ADR-004) | `scripts/package-map-tiles.js` | `src/lib/offlineTileHandler.js` in the service worker |

Code: `src/lib/offlineBundle.js`.

## Manifest

```json
{
  "format": "helphone-offline-bundle/1",
  "kind": "map-tiles",
  "zone": "lagos-island",
  "version": 3,
  "files": [{ "path": "v3/14/8346/7897.pbf", "sha256": "…", "bytes": 18234, "z": 14, "x": 8346, "y": 7897 }],
  "bbox": [3.38, 6.44, 3.42, 6.47], "minZoom": 12, "maxZoom": 16, "ext": "pbf",
  "tileUrlTemplate": "/offline-tiles/lagos-island/v3/{z}/{x}/{y}.pbf"
}
```

- `version` is a positive integer that grows with each release of a zone. File paths carry it (`<zone>.v3.hpgr`, `v3/z/x/y.pbf`), so every release is cached separately.
- The manifest is serialised canonically: keys sorted, files sorted by path, no timestamps. The same input always gives byte-identical output. `.github/workflows/routing-tiles.yml` rebuilds a routing tile from shuffled input and fails on any difference.
- A client verifies every file's size and SHA-256 against the manifest before using it, whether the file came from the network or the cache.

## Signing (map tiles)

A map tile manifest is wrapped with an Ed25519 signature over its canonical JSON:

```json
{ "manifest": { … }, "signature": { "alg": "Ed25519", "keyId": "600160f2ad21864e", "value": "<base64>" } }
```

- `keyId` is the first 16 hex characters of SHA-256 over the raw public key.
- The service worker trusts only keys compiled into the build from `VITE_TILE_SIGNING_KEYS` (`src/lib/tileTrust.js`). The trust root is never fetched at runtime, because a key served by the tile host could be replaced together with the tiles.
- A manifest that is unsigned, signed by an unknown key, or altered after signing is refused (`TILE_ANOMALY` / `MANIFEST_REJECTED`), and the last verified manifest stays in use.

Key handling:

```bash
node scripts/package-map-tiles.js --generate-key secrets/tile-signing
# → secrets/tile-signing.private.jwk (keep out of git), and the public key JSON
#   to put in VITE_TILE_SIGNING_KEYS when building the app
```

To rotate a key, add the new public key to `VITE_TILE_SIGNING_KEYS` next to the old one, ship that build, and only then sign releases with the new key.

## Packaging a zone

```bash
node scripts/package-map-tiles.js --zone lagos-island --version 3 \
  --bbox 3.38,6.44,3.42,6.47 --min-zoom 12 --max-zoom 16 \
  --source tiles/ --ext pbf --key secrets/tile-signing.private.jwk --out public/offline-tiles
```

`--source` is a directory of `<z>/<x>/<y>.<ext>` tiles, for example extracted from an MBTiles archive. The output is `public/offline-tiles/<zone>/manifest.json` plus the tiles under `<zone>/v<version>/`. Ed25519 signatures are deterministic, so packaging the same tiles with the same key twice gives the same bytes. A zone is capped at 20,000 tiles; lower `--max-zoom` for a bigger area.

## Service worker behaviour

For `GET /offline-tiles/<zone>/v<n>/<z>/<x>/<y>.<ext>`:

1. Load the zone's verified manifest: network first, then the last verified copy.
2. Serve a cached copy of the tile when one verifies (cache-first; a release's tiles never change).
3. Otherwise fetch the tile, verify it against the manifest, cache it and serve it.
4. **A tile that fails verification is rejected** and reported as `TILE_ANOMALY` / `TAMPERED`. The same tile from an earlier verified release is served when one is cached; otherwise the response is 502.

Posting `{ type: "OFFLINE_TILES_INSTALL", zone }` to the service worker packages the zone for offline use. It downloads and verifies every tile of the current release, reports `OFFLINE_TILES_PROGRESS`, and then deletes older releases. If any tile fails, older releases are kept, so the previous verified map stays usable.

Offline tile and routing caches are kept across service worker updates: the `activate` clean-up skips the `helphone-offline-tiles-` and `helphone-routing-tiles-` prefixes.
