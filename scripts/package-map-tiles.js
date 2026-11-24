#!/usr/bin/env node
/**
 * Package an off-grid map tile bundle for an incident zone (#896).
 *
 *   # one time: create a signing key pair (keep the private key out of git)
 *   node scripts/package-map-tiles.js --generate-key secrets/tile-signing
 *
 *   node scripts/package-map-tiles.js --zone lagos-island --version 1 \
 *        --bbox 3.38,6.44,3.42,6.47 --min-zoom 12 --max-zoom 16 \
 *        --source tiles/ --ext pbf --key secrets/tile-signing.private.jwk \
 *        [--out public/offline-tiles]
 *
 * --source is a directory of `<z>/<x>/<y>.<ext>` tiles (e.g. extracted from an
 * MBTiles archive). Writes `<out>/<zone>/manifest.json` (signed) and the
 * tiles under `<out>/<zone>/v<version>/`. Ed25519 signatures are
 * deterministic, so the same tiles and key always give a byte-identical
 * bundle. The public key goes into VITE_TILE_SIGNING_KEYS at build time.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { buildMapTileBundle } from "../src/lib/mapTileBundle.js";
import { _toBase64, bundleKeyId, canonicalJson, sha256Hex, signBundleManifest } from "../src/lib/offlineBundle.js";

const { subtle } = webcrypto;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

function fail(msg) {
  console.error(`package-map-tiles: ${msg}`);
  process.exit(2);
}

const generate = arg("generate-key");
if (typeof generate === "string") {
  const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  const keyId = await bundleKeyId(raw);
  await mkdir(path.dirname(generate), { recursive: true });
  await writeFile(`${generate}.private.jwk`, JSON.stringify(jwk), { mode: 0o600 });
  await writeFile(`${generate}.public.json`, `${JSON.stringify({ [keyId]: _toBase64(raw) })}\n`);
  console.log(JSON.stringify({ keyId, publicKey: _toBase64(raw), privateKeyFile: `${generate}.private.jwk` }, null, 2));
  console.log(`Set VITE_TILE_SIGNING_KEYS='${JSON.stringify({ [keyId]: _toBase64(raw) })}' when building the app.`);
  process.exit(0);
}

const zone = arg("zone");
const version = Number(arg("version"));
const bbox = typeof arg("bbox") === "string" ? arg("bbox").split(",").map(Number) : null;
const minZoom = Number(arg("min-zoom"));
const maxZoom = Number(arg("max-zoom"));
const source = arg("source");
const ext = arg("ext", "pbf");
const keyFile = arg("key");
const out = arg("out", "public/offline-tiles");
if (typeof zone !== "string") fail("--zone is required");
if (!Number.isSafeInteger(version) || version < 1) fail("--version must be a positive integer");
if (!bbox || bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) fail("--bbox must be west,south,east,north");
if (typeof source !== "string") fail("--source is required");
if (typeof keyFile !== "string") fail("--key is required (see --generate-key)");

const jwk = JSON.parse(await readFile(keyFile, "utf8"));
const privateKey = await subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
const publicKey = await subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: "Ed25519" }, true, ["verify"]);
const raw = new Uint8Array(await subtle.exportKey("raw", publicKey));

const readTile = async (z, x, y) => {
  try {
    return new Uint8Array(await readFile(path.join(source, String(z), String(x), `${y}.${ext}`)));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
};

const { manifest, files, missing } = await buildMapTileBundle({ zone, version, bbox, minZoom, maxZoom, ext, readTile });
const signed = await signBundleManifest(manifest, privateKey, raw);
const zoneDir = path.join(out, zone);
for (const f of files) {
  const dest = path.join(zoneDir, f.path);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, f.bytes);
}
const manifestText = `${canonicalJson(signed)}\n`;
await writeFile(path.join(zoneDir, "manifest.json"), manifestText);
console.log(
  JSON.stringify(
    {
      zone,
      version,
      tiles: files.length,
      missingInSource: missing,
      bytes: files.reduce((n, f) => n + f.bytes.byteLength, 0),
      keyId: signed.signature.keyId,
      manifestSha256: await sha256Hex(manifestText),
      out: zoneDir,
    },
    null,
    2,
  ),
);
