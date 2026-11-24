// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import {
  parseVkManifest,
  signVkManifest,
  verifyVkManifest,
  decideVkAcceptance,
  negotiateVk,
  VK_MANIFEST_PUBLIC_KEY_JWK,
} from '../src/lib/vkManifest.js';

const H1 = `0x${'1'.repeat(64)}`; // superseded VK
const H2 = `0x${'2'.repeat(64)}`; // current VK
const H3 = `0x${'3'.repeat(64)}`; // never seen

const ISSUED = '2026-11-23T00:00:00.000Z';
const GRACE_UNTIL = '2026-11-24T00:00:00.000Z';
const BEFORE_GRACE = Date.parse('2026-11-23T12:00:00.000Z');
const AFTER_GRACE = Date.parse('2026-11-24T06:00:00.000Z');

const subtle = globalThis.crypto.subtle;

function unsignedManifest(overrides = {}) {
  return {
    version: 1,
    circuit: 'responder_credential',
    vkVersion: 2,
    vkHash: H2,
    supersedes: [H1],
    issuedAt: ISSUED,
    graceUntil: GRACE_UNTIL,
    ...overrides,
  };
}

let privJwk;
let pubJwk;
let otherPubJwk;
let signed;

beforeAll(async () => {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  privJwk = await subtle.exportKey('jwk', pair.privateKey);
  pubJwk = await subtle.exportKey('jwk', pair.publicKey);
  const other = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  otherPubJwk = await subtle.exportKey('jwk', other.publicKey);
  signed = await signVkManifest(unsignedManifest(), privJwk, subtle);
});

describe('VK manifest format (ISP-051 / #937)', () => {
  it('rejects malformed hashes, versions and times', () => {
    expect(() => parseVkManifest(unsignedManifest({ vkHash: '0xabc' }))).toThrow('vkHash');
    expect(() => parseVkManifest(unsignedManifest({ vkVersion: 0 }))).toThrow('vkVersion');
    expect(() => parseVkManifest(unsignedManifest({ supersedes: ['nope'] }))).toThrow('supersedes');
    expect(() => parseVkManifest(unsignedManifest({ graceUntil: ISSUED }))).toThrow('graceUntil must be after issuedAt');
    expect(() => parseVkManifest(unsignedManifest({ version: 2 }))).toThrow('version');
  });
});

describe('VK manifest signature (ISP-051 / #937)', () => {
  it('verifies against the signing key and nothing else', async () => {
    expect(await verifyVkManifest(signed, pubJwk, subtle)).toBe(true);
    expect(await verifyVkManifest(signed, otherPubJwk, subtle)).toBe(false);
  });

  it('fails when any signed field is changed', async () => {
    const tampered = { ...signed, graceUntil: '2030-01-01T00:00:00.000Z' };
    expect(await verifyVkManifest(tampered, pubJwk, subtle)).toBe(false);
    const swapped = { ...signed, vkHash: H3 };
    expect(await verifyVkManifest(swapped, pubJwk, subtle)).toBe(false);
  });

  it('fails closed when no public key is pinned', async () => {
    expect(VK_MANIFEST_PUBLIC_KEY_JWK).toBeNull();
    expect(await verifyVkManifest(signed, VK_MANIFEST_PUBLIC_KEY_JWK, subtle)).toBe(false);
  });

  it('fails when the signature is missing', async () => {
    expect(await verifyVkManifest(unsignedManifest(), pubJwk, subtle)).toBe(false);
  });
});

describe('VK acceptance decision (ISP-051 / #937)', () => {
  const manifest = parseVkManifest(signed);
  const current = { vkVersion: 2, vkHash: H2 };

  it('accepts the current VK while online', () => {
    expect(decideVkAcceptance({ manifest, held: current, now: BEFORE_GRACE, online: true })).toMatchObject({
      accept: true, reason: 'current', purge: false,
    });
  });

  it('accepts the current VK offline only until the signed grace expiry', () => {
    expect(decideVkAcceptance({ manifest, held: current, now: BEFORE_GRACE, online: false })).toMatchObject({
      accept: true, reason: 'offline-grace',
    });
    expect(decideVkAcceptance({ manifest, held: current, now: AFTER_GRACE, online: false })).toMatchObject({
      accept: false, reason: 'grace-expired', purge: true,
    });
  });

  it('never accepts a superseded VK, even inside the grace window', () => {
    expect(decideVkAcceptance({ manifest, held: { vkVersion: 1, vkHash: H1 }, now: BEFORE_GRACE, online: true })).toMatchObject({
      accept: false, reason: 'superseded', purge: true,
    });
  });

  it('rejects an unknown VK and a version mismatch', () => {
    expect(decideVkAcceptance({ manifest, held: { vkVersion: 2, vkHash: H3 }, now: BEFORE_GRACE, online: true })).toMatchObject({
      accept: false, reason: 'unknown-vk', purge: true,
    });
    expect(decideVkAcceptance({ manifest, held: { vkVersion: 1, vkHash: H2 }, now: BEFORE_GRACE, online: true })).toMatchObject({
      accept: false, reason: 'version-mismatch',
    });
  });

  it('rejects when there is no held VK or no verified manifest', () => {
    expect(decideVkAcceptance({ manifest, held: null, now: BEFORE_GRACE, online: true })).toMatchObject({ reason: 'no-held-vk' });
    expect(decideVkAcceptance({ manifest: null, held: current, now: BEFORE_GRACE, online: true })).toMatchObject({
      accept: false, reason: 'no-verified-manifest',
    });
  });
});

describe('VK negotiation with the server (ISP-051 / #937)', () => {
  const current = { vkVersion: 2, vkHash: H2 };
  const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

  it('accepts a freshly fetched, correctly signed manifest', async () => {
    const result = await negotiateVk({
      fetchImpl: async () => jsonResponse(signed),
      held: current,
      now: BEFORE_GRACE,
      publicKeyJwk: pubJwk,
      subtle,
    });
    expect(result).toMatchObject({ accept: true, reason: 'current', online: true });
  });

  it('refuses a manifest with a bad signature and does not fall back to the cache', async () => {
    const result = await negotiateVk({
      fetchImpl: async () => jsonResponse({ ...signed, vkHash: H3 }),
      cachedManifest: signed,
      held: current,
      now: BEFORE_GRACE,
      publicKeyJwk: pubJwk,
      subtle,
    });
    expect(result).toMatchObject({ accept: false, reason: 'bad-signature', purge: true });
  });

  it('uses the signed cached manifest when the network fails, inside the grace window', async () => {
    const result = await negotiateVk({
      fetchImpl: async () => {
        throw new TypeError('offline');
      },
      cachedManifest: signed,
      held: current,
      now: BEFORE_GRACE,
      publicKeyJwk: pubJwk,
      subtle,
    });
    expect(result).toMatchObject({ accept: true, reason: 'offline-grace', online: false });
  });

  it('rejects offline use once the cached manifest has expired', async () => {
    const result = await negotiateVk({
      fetchImpl: async () => new Response('down', { status: 503 }),
      cachedManifest: signed,
      held: current,
      now: AFTER_GRACE,
      publicKeyJwk: pubJwk,
      subtle,
    });
    expect(result).toMatchObject({ accept: false, reason: 'grace-expired' });
  });

  it('fails closed with no network and no verified cache', async () => {
    const result = await negotiateVk({
      fetchImpl: async () => {
        throw new TypeError('offline');
      },
      cachedManifest: { ...signed, signature: 'AAAA' },
      held: current,
      now: BEFORE_GRACE,
      publicKeyJwk: pubJwk,
      subtle,
    });
    expect(result).toMatchObject({ accept: false, reason: 'no-verified-manifest' });
  });
});
