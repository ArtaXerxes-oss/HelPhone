#!/usr/bin/env node
/**
 * Build an HPGR routing tile bundle for one incident zone (#893).
 *
 *   node scripts/build-routing-tiles.js --input roads.geojson --zone lagos-island \
 *        --version 1 [--weighting time|distance] [--out public/routing-tiles]
 *
 *   node scripts/build-routing-tiles.js --input roads.geojson --zone lagos-island \
 *        --version 1 --check public/routing-tiles
 *     Rebuilds in memory and fails unless the tile and manifest are
 *     byte-identical to the ones in the given directory (CI reproducibility).
 *
 * Writes `<zone>.v<version>.hpgr` and `<zone>.manifest.json` into --out.
 * The input is GeoJSON with OSM tags as properties; see src/lib/routingTiles.js
 * for how to produce it from an OSM extract with osmium.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { buildRoutingTile } from "../src/lib/routingTiles.js";
import { canonicalJson, sha256Hex } from "../src/lib/offlineBundle.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

function usage(msg) {
  console.error(`build-routing-tiles: ${msg}`);
  console.error("usage: --input <file.geojson> --zone <id> --version <n> [--weighting time|distance] [--out <dir> | --check <dir>]");
  process.exit(2);
}

const input = arg("input");
const zone = arg("zone");
const version = Number(arg("version"));
const weighting = arg("weighting", "time");
const check = arg("check");
const out = arg("out", "public/routing-tiles");
if (typeof input !== "string") usage("--input is required");
if (typeof zone !== "string") usage("--zone is required");
if (!Number.isSafeInteger(version) || version < 1) usage("--version must be a positive integer");

const t0 = performance.now();
const geojson = JSON.parse(await readFile(input, "utf8"));
const { manifest, tile, graph } = await buildRoutingTile(geojson, { zone, version, weighting });
const manifestText = `${canonicalJson(manifest)}\n`;
const tileName = manifest.files[0].path;
const manifestName = `${zone}.manifest.json`;
const summary = {
  zone,
  version,
  weighting: graph.weighting,
  nodeCount: graph.nodeCount,
  edgeCount: graph.edgeCount,
  tileBytes: tile.byteLength,
  tileSha256: manifest.files[0].sha256,
  manifestSha256: await sha256Hex(manifestText),
  destinations: manifest.destinations.length,
  buildMs: Math.round(performance.now() - t0),
};

if (typeof check === "string") {
  const [haveTile, haveManifest] = await Promise.all([
    readFile(path.join(check, tileName)),
    readFile(path.join(check, manifestName), "utf8"),
  ]);
  const tileOk = Buffer.compare(Buffer.from(tile), haveTile) === 0;
  const manifestOk = haveManifest === manifestText;
  console.log(JSON.stringify({ ...summary, check, tileOk, manifestOk }, null, 2));
  if (!tileOk || !manifestOk) {
    console.error("build-routing-tiles: rebuilt bundle differs from the committed one");
    process.exit(1);
  }
} else {
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, tileName), tile);
  await writeFile(path.join(out, manifestName), manifestText);
  console.log(JSON.stringify({ ...summary, out }, null, 2));
}
