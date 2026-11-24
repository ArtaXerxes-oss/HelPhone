# Offline routing tiles

Routing zones served to the Help page's offline evacuation route panel (#893).

- `index.json` lists the installed zones: `{ "zones": [{ "zone": "lagos-island", "name": "Lagos Island" }] }`.
- Each zone has `<zone>.manifest.json` and `<zone>.v<version>.hpgr`, built with
  `node scripts/build-routing-tiles.js` from an OSM extract (see `src/lib/routingTiles.js`).

No zone is installed in the repository. Only publish tiles built from real,
licensed road data for the incident zone (OpenStreetMap data needs ODbL
attribution), never from `scripts/generate-routing-fixture.js`.
