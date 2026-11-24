// @vitest-environment node
/**
 * #896 — off-grid map tile packaging with integrity verification.
 */
import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { buildMapTileBundle, lngLatToTile, tilesForBbox } from "../src/lib/mapTileBundle.js";
import { _toBase64, bundleKeyId, canonicalJson, signBundleManifest, verifySignedManifest } from "../src/lib/offlineBundle.js";
import { createOfflineTileHandler, parseOfflineTileUrl, tileCacheName } from "../src/lib/offlineTileHandler.js";
import { parseTrustedTileKeys } from "../src/lib/tileTrust.js";

const { subtle } = webcrypto;
const BBOX = [3.38, 6.44, 3.42, 6.47]; // Lagos Island area

async function keyPair() {
  const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const keyId = await bundleKeyId(raw);
  return { ...pair, raw, keyId, trusted: { [keyId]: _toBase64(raw) } };
}

/** Deterministic fake vector tile bytes for z/x/y (and a release tag). */
const tileBytes = (z, x, y, tag = "") => new TextEncoder().encode(`tile ${z}/${x}/${y}${tag} `.repeat(8));

async function signedBundle(key, version, { tag = "" } = {}) {
  const { manifest, files } = await buildMapTileBundle({
    zone: "lagos-island",
    version,
    bbox: BBOX,
    minZoom: 12,
    maxZoom: 14,
    readTile: async (z, x, y) => tileBytes(z, x, y, tag),
  });
  return { signed: await signBundleManifest(manifest, key.privateKey, key.raw), files, manifest };
}

describe("tile coverage", () => {
  it("maps coordinates to slippy-map tiles", () => {
    expect(lngLatToTile(0, 0, 0)).toEqual([0, 0]);
    expect(lngLatToTile(3.4, 6.45, 12)).toEqual([2086, 1974]);
    expect(lngLatToTile(-180, 85.06, 3)).toEqual([0, 0]);
  });

  it("lists every tile covering the bbox at each zoom", () => {
    const tiles = tilesForBbox(BBOX, 12, 14);
    const at = (z) => tiles.filter((t) => t[0] === z).length;
    expect(at(12)).toBe(1);
    expect(at(13)).toBe(2 * 2);
    expect(at(14)).toBe(3 * 3);
    expect(() => tilesForBbox([1, 1, 0, 2], 1, 2)).toThrow(/bbox/);
    expect(() => tilesForBbox([-180, -85, 180, 85], 0, 22)).toThrow(/more than/);
  });
});

describe("signed bundle", () => {
  it("is reproducible: same tiles and key give a byte-identical signed manifest", async () => {
    const key = await keyPair();
    const a = await signedBundle(key, 1);
    const b = await signedBundle(key, 1);
    expect(canonicalJson(a.signed)).toBe(canonicalJson(b.signed));
    expect(a.manifest.tileUrlTemplate).toBe("/offline-tiles/lagos-island/v1/{z}/{x}/{y}.pbf");
    expect(a.manifest.files).toHaveLength(14);
  });

  it("verifies against the trusted key and refuses altered, unknown-key and unsigned manifests", async () => {
    const key = await keyPair();
    const other = await keyPair();
    const { signed } = await signedBundle(key, 1);
    await expect(verifySignedManifest(signed, key.trusted, { kind: "map-tiles" })).resolves.toMatchObject({ version: 1 });

    const altered = structuredClone(signed);
    altered.manifest.files[0].sha256 = "0".repeat(64);
    await expect(verifySignedManifest(altered, key.trusted)).rejects.toMatchObject({ reason: "bad-signature" });
    await expect(verifySignedManifest(signed, other.trusted)).rejects.toMatchObject({ reason: "unknown-key" });
    await expect(verifySignedManifest({ manifest: signed.manifest }, key.trusted)).rejects.toMatchObject({ reason: "unsigned" });
    // A trust entry whose key does not hash to its id is not accepted.
    await expect(verifySignedManifest(signed, { [key.keyId]: other.trusted[other.keyId] })).rejects.toMatchObject({ reason: "unknown-key" });
  });

  it("parses the build-time trust store and drops malformed entries", () => {
    const good = { "0123456789abcdef": `${"A".repeat(43)}=` };
    expect(parseTrustedTileKeys(JSON.stringify({ ...good, nothex: "x", "fedcba9876543210": "short" }))).toEqual(good);
    expect(parseTrustedTileKeys("not json")).toEqual({});
    expect(parseTrustedTileKeys(undefined)).toEqual({});
  });
});

// ── Service worker handler ──────────────────────────────────────────────────

function memoryCaches() {
  const stores = new Map();
  const api = {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        async match(k) {
          const hit = m.get(String(k));
          return hit ? hit.clone() : undefined;
        },
        async put(k, res) {
          m.set(String(k), res.clone());
        },
        async delete(k) {
          return m.delete(String(k));
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
  };
  return api;
}

/** A tile host serving a published bundle, with switches to tamper or go offline. */
function tileHost() {
  const files = new Map();
  const state = { online: true, requests: [] };
  const publish = ({ signed, files: tiles }, mutate = (b) => b) => {
    files.set("/offline-tiles/lagos-island/manifest.json", canonicalJson(signed));
    for (const f of tiles) files.set(`/offline-tiles/lagos-island/${f.path}`, mutate(f.bytes.slice(), f.path));
  };
  const fetchImpl = async (url) => {
    state.requests.push(url);
    if (!state.online) throw new TypeError("Failed to fetch (offline)");
    const body = files.get(url);
    return body === undefined ? new Response("nope", { status: 404 }) : new Response(body, { status: 200 });
  };
  return { files, state, publish, fetchImpl };
}

const firstTile = (bundle) => `/offline-tiles/lagos-island/${bundle.manifest.files[0].path}`;

describe("offline tile handler", () => {
  it("parses only offline tile URLs", () => {
    expect(parseOfflineTileUrl("/offline-tiles/lagos-island/v3/14/8346/7901.pbf")).toMatchObject({ zone: "lagos-island", version: 3, z: 14, path: "v3/14/8346/7901.pbf" });
    expect(parseOfflineTileUrl("/offline-tiles/lagos-island/manifest.json")).toBeNull();
    expect(parseOfflineTileUrl("/offline-tiles/../etc/v1/1/1/1.pbf")).toBeNull();
  });

  it("rejects a tampered tile when there is no verified copy", async () => {
    const key = await keyPair();
    const bundle = await signedBundle(key, 1);
    const host = tileHost();
    host.publish(bundle, (bytes) => {
      bytes[0] ^= 0xff;
      return bytes;
    });
    const events = [];
    const h = createOfflineTileHandler({ cacheStorage: memoryCaches(), fetchImpl: host.fetchImpl, trustedKeys: key.trusted, notify: (e) => events.push(e) });
    const res = await h.handle(firstTile(bundle));
    expect(res.status).toBe(502);
    expect(events).toContainEqual(expect.objectContaining({ type: "TILE_ANOMALY", payload: expect.objectContaining({ reason: "TAMPERED", detail: "hash-mismatch" }) }));
  });

  it("serves the cached copy when a newer release's tile is tampered with", async () => {
    const key = await keyPair();
    const host = tileHost();
    const caches = memoryCaches();
    const events = [];
    const h = createOfflineTileHandler({ cacheStorage: caches, fetchImpl: host.fetchImpl, trustedKeys: key.trusted, notify: (e) => events.push(e) });

    const v1 = await signedBundle(key, 1);
    host.publish(v1);
    expect((await h.install("lagos-island")).failed).toEqual([]);

    // v2 is signed correctly, but the host serves altered bytes for its tiles.
    const v2 = await signedBundle(key, 2, { tag: " v2" });
    host.publish(v2, (bytes) => {
      bytes[3] ^= 0x01;
      return bytes;
    });
    const result = await h.install("lagos-island");
    expect(result).toMatchObject({ version: 2 });
    expect(result.failed).toHaveLength(v2.manifest.files.length);
    // v1 is kept because v2 did not fully verify.
    expect(await caches.keys()).toContain(tileCacheName("lagos-island", 1));

    const res = await h.handle(firstTile(v2));
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toContain("tile 12/2086/1974 ");
    expect(events.filter((e) => e.payload?.reason === "TAMPERED").length).toBeGreaterThan(0);
  });

  it("refuses a manifest signed by an untrusted key and keeps the last verified one", async () => {
    const key = await keyPair();
    const attacker = await keyPair();
    const host = tileHost();
    const caches = memoryCaches();
    const events = [];
    const v1 = await signedBundle(key, 1);
    host.publish(v1);
    await createOfflineTileHandler({ cacheStorage: caches, fetchImpl: host.fetchImpl, trustedKeys: key.trusted }).install("lagos-island");

    const forged = await signedBundle(attacker, 2, { tag: " evil" });
    host.publish(forged);
    const h = createOfflineTileHandler({ cacheStorage: caches, fetchImpl: host.fetchImpl, trustedKeys: key.trusted, notify: (e) => events.push(e) });
    const res = await h.handle(firstTile(v1));
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(await res.arrayBuffer())).not.toContain("evil");
    expect(events).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ reason: "MANIFEST_REJECTED", detail: "unknown-key" }) }));
    // A tile URL from the forged release gets the last verified copy, never the forged bytes.
    const fromForged = await h.handle(firstTile(forged));
    expect(fromForged.status).toBe(200);
    expect(new TextDecoder().decode(await fromForged.arrayBuffer())).not.toContain("evil");
  });

  it("installs a zone and drops older releases once the new one fully verifies", async () => {
    const key = await keyPair();
    const host = tileHost();
    const caches = memoryCaches();
    const h = createOfflineTileHandler({ cacheStorage: caches, fetchImpl: host.fetchImpl, trustedKeys: key.trusted });
    host.publish(await signedBundle(key, 1));
    await h.install("lagos-island");
    host.publish(await signedBundle(key, 2, { tag: " v2" }));
    const progress = [];
    const r = await h.install("lagos-island", { onProgress: (p) => progress.push(p.done) });
    expect(r).toMatchObject({ version: 2, tiles: 14, failed: [] });
    expect(progress.at(-1)).toBe(14);
    const names = await caches.keys();
    expect(names).toContain(tileCacheName("lagos-island", 2));
    expect(names).not.toContain(tileCacheName("lagos-island", 1));
  });

  it("renders the packaged zone offline (E2E): every viewport tile served from the verified cache", async () => {
    const key = await keyPair();
    const host = tileHost();
    const caches = memoryCaches();
    const bundle = await signedBundle(key, 1);
    host.publish(bundle);
    await createOfflineTileHandler({ cacheStorage: caches, fetchImpl: host.fetchImpl, trustedKeys: key.trusted }).install("lagos-island");

    // A cold service worker with no network at all.
    host.state.online = false;
    const h = createOfflineTileHandler({ cacheStorage: caches, fetchImpl: host.fetchImpl, trustedKeys: key.trusted });
    const template = bundle.manifest.tileUrlTemplate;
    for (const [z, x, y] of tilesForBbox(BBOX, 12, 14)) {
      const res = await h.handle(template.replace("{z}", z).replace("{x}", x).replace("{y}", y));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-helphone-tile-source")).toBe("cache");
      expect(res.headers.get("content-type")).toBe("application/x-protobuf");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(tileBytes(z, x, y));
    }
  });
});
