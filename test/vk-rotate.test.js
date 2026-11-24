// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  checkLayerConsistency,
  assertPublishAllowed,
  buildUnsignedManifest,
  normalizeHash,
} from '../scripts/vk-rotate.mjs';

const H1 = `0x${'1'.repeat(64)}`;
const H2 = `0x${'2'.repeat(64)}`;
const H3 = `0x${'3'.repeat(64)}`;

describe('VK rotation consistency gate (ISP-051 / #936)', () => {
  it('passes only when every layer reports and all agree', () => {
    const result = checkLayerConsistency({ layers: { manifest: H2, recursive: H2, onchain: H2 } });
    expect(result.ok).toBe(true);
    expect(result.distinct).toEqual([H2]);
  });

  it('compares hashes case-insensitively', () => {
    const upper = `0x${'AB'.repeat(32)}`;
    const result = checkLayerConsistency({ layers: { manifest: upper, recursive: upper.toLowerCase() } });
    expect(result.ok).toBe(true);
  });

  it('blocks a partial rotation where one layer still holds the old VK', () => {
    const result = checkLayerConsistency({ layers: { manifest: H2, recursive: H1, onchain: H2 } });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('partial rotation');
    expect(result.message).toContain(`recursive=${H1}`);
  });

  it('blocks when a layer does not report, so a missing on-chain value cannot pass', () => {
    const result = checkLayerConsistency({ layers: { manifest: H2, recursive: H2, onchain: null } });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['onchain']);
  });

  it('treats a malformed hash as not reporting', () => {
    expect(normalizeHash('0x1234')).toBeNull();
    const result = checkLayerConsistency({ layers: { manifest: H2, recursive: '0x1234' } });
    expect(result.missing).toEqual(['recursive']);
  });
});

describe('VK publish guard (ISP-051 / #936)', () => {
  const previousManifest = {
    version: 1,
    circuit: 'responder_credential',
    vkVersion: 1,
    vkHash: H1,
    supersedes: [],
    issuedAt: '2026-11-01T00:00:00.000Z',
    graceUntil: '2026-11-02T00:00:00.000Z',
  };

  it('refuses to publish until the recursive verifier is pinned to the new hash', () => {
    expect(() => assertPublishAllowed({ vkVersion: 2, vkHash: H2, previousManifest, recursivePin: H1 })).toThrow(
      'recursive verifier pin is',
    );
    expect(() => assertPublishAllowed({ vkVersion: 2, vkHash: H2, previousManifest, recursivePin: null })).toThrow('unset');
  });

  it('requires the version to increase and the hash to change', () => {
    expect(() => assertPublishAllowed({ vkVersion: 1, vkHash: H2, previousManifest, recursivePin: H2 })).toThrow('greater than');
    expect(() => assertPublishAllowed({ vkVersion: 2, vkHash: H1, previousManifest, recursivePin: H1 })).toThrow('nothing to rotate');
  });

  it('allows the first publish, and a rotation once the pin matches', () => {
    expect(() => assertPublishAllowed({ vkVersion: 1, vkHash: H1, previousManifest: null, recursivePin: H1 })).not.toThrow();
    expect(() => assertPublishAllowed({ vkVersion: 2, vkHash: H2, previousManifest, recursivePin: H2 })).not.toThrow();
  });

  it('rejects a malformed hash or version before looking at anything else', () => {
    expect(() => assertPublishAllowed({ vkVersion: 2, vkHash: '0xzz', previousManifest, recursivePin: H2 })).toThrow('--vk-hash');
    expect(() => assertPublishAllowed({ vkVersion: 0, vkHash: H2, previousManifest, recursivePin: H2 })).toThrow('--vk-version');
  });
});

describe('unsigned manifest builder (ISP-051 / #937)', () => {
  it('keeps every earlier hash in supersedes and sets the grace expiry from the hours given', () => {
    const previous = {
      version: 1,
      circuit: 'responder_credential',
      vkVersion: 2,
      vkHash: H2,
      supersedes: [H1],
      issuedAt: '2026-11-01T00:00:00.000Z',
      graceUntil: '2026-11-02T00:00:00.000Z',
    };
    const built = buildUnsignedManifest({
      vkVersion: 3,
      vkHash: H3,
      previousManifest: previous,
      graceHours: 12,
      now: new Date('2026-11-23T00:00:00.000Z'),
    });
    expect(built).toMatchObject({
      version: 1,
      circuit: 'responder_credential',
      vkVersion: 3,
      vkHash: H3,
      supersedes: [H2, H1],
      issuedAt: '2026-11-23T00:00:00.000Z',
      graceUntil: '2026-11-23T12:00:00.000Z',
    });
    expect(built).not.toHaveProperty('signature');
  });
});
