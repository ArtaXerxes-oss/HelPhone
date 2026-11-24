#!/usr/bin/env node
/**
 * Writes a deterministic, OSM-tagged synthetic road network as GeoJSON, for
 * the routing tile reproducibility job and local experiments (#893). It is a
 * fixture, not map data: never publish a tile built from it for a real zone.
 *
 *   node scripts/generate-routing-fixture.js --out /tmp/roads.geojson [--rows 60] [--shuffle-seed 3]
 *
 * --shuffle-seed reorders features and tag keys, which must not change the
 * built tile.
 */
import { writeFile } from "node:fs/promises";
import { createRng, generateRoadNetworkGeoJSON } from "../src/utils/graphTraversal.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const out = arg("out");
if (typeof out !== "string") {
  console.error("usage: --out <file.geojson> [--rows n] [--shuffle-seed n]");
  process.exit(2);
}
const rows = Number(arg("rows", 60));
const shuffleSeed = arg("shuffle-seed", null);

const geojson = generateRoadNetworkGeoJSON({ rows, cols: rows, shapePoints: 2 });
const rand = createRng(7);
const classes = ["primary", "secondary", "tertiary", "residential", "residential", "service"];
for (const f of geojson.features) {
  f.properties.highway = classes[Math.floor(rand() * classes.length)];
  const r = rand();
  if (r < 0.15) f.properties.maxspeed = "60";
  else if (r < 0.2) f.properties.maxspeed = "20 mph";
  else if (r < 0.22) f.properties.closed = "yes";
}
const [lng0, lat0] = geojson.features[0].geometry.coordinates[0];
geojson.features.push(
  { type: "Feature", properties: { amenity: "shelter", name: "Fixture shelter" }, geometry: { type: "Point", coordinates: [lng0 + 0.02, lat0 + 0.02] } },
  { type: "Feature", properties: { amenity: "hospital", name: "Fixture hospital" }, geometry: { type: "Point", coordinates: [lng0 + 0.04, lat0 + 0.01] } },
);

if (shuffleSeed !== null) {
  const shuffle = createRng(Number(shuffleSeed));
  const fs = geojson.features;
  for (let i = fs.length - 1; i > 0; i--) {
    const j = Math.floor(shuffle() * (i + 1));
    [fs[i], fs[j]] = [fs[j], fs[i]];
  }
  for (const f of fs) f.properties = Object.fromEntries(Object.entries(f.properties).reverse());
}
await writeFile(out, JSON.stringify(geojson));
console.log(`wrote ${geojson.features.length} features to ${out}`);
