import { describe, it, expect } from 'vitest'
import {
  attachFrankingTag,
  verifyFrankingTag,
  FRANKING_MAC_BYTES,
} from '../src/lib/crypto.js'

const FRANK_KEY = 'moderator-escrow-key-v1'
const ciphertext = new TextEncoder().encode('help, meet at the north gate')

describe('message franking (ISP-056 / #726)', () => {
  it('round-trips: a tag attached under the key verifies against the same ciphertext', () => {
    const tag = attachFrankingTag(ciphertext, FRANK_KEY, 'frank-v1')
    expect(tag.keyId).toBe('frank-v1')
    expect(verifyFrankingTag(ciphertext, tag, FRANK_KEY)).toBe(true)
  })

  it('rejects a fabricated report: wrong key fails verification', () => {
    const tag = attachFrankingTag(ciphertext, FRANK_KEY, 'frank-v1')
    const forged = new TextEncoder().encode('help, meet at the south gate')
    expect(verifyFrankingTag(forged, tag, FRANK_KEY)).toBe(false)
    expect(verifyFrankingTag(ciphertext, tag, 'attacker-key')).toBe(false)
  })

  it('rejects a tampered mac or nonce', () => {
    const tag = attachFrankingTag(ciphertext, FRANK_KEY, 'frank-v1')
    const flippedMac = (parseInt(tag.mac.slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, '0')
    expect(verifyFrankingTag(ciphertext, { ...tag, mac: flippedMac + tag.mac.slice(2) }, FRANK_KEY)).toBe(false)
    expect(verifyFrankingTag(ciphertext, { ...tag, nonce: tag.nonce.replace(/^../, '00') }, FRANK_KEY)).toBe(false)
  })

  it('returns false (never throws) on malformed tags so moderators can batch-check', () => {
    expect(verifyFrankingTag(ciphertext, null, FRANK_KEY)).toBe(false)
    expect(verifyFrankingTag(ciphertext, { keyId: '', nonce: 'zz', mac: 'zz' }, FRANK_KEY)).toBe(false)
    expect(verifyFrankingTag(ciphertext, { keyId: 'k', nonce: 'ab', mac: 'cd' }, FRANK_KEY)).toBe(false)
  })

  it('keyId enables rotation: the same ciphertext verifies under the historical key', () => {
    const oldTag = attachFrankingTag(ciphertext, 'old-frank-key', 'frank-v1')
    const rotated = attachFrankingTag(ciphertext, FRANK_KEY, 'frank-v2')
    // A verifier with a keyId→key directory checks old reports read-only…
    expect(verifyFrankingTag(ciphertext, oldTag, 'old-frank-key')).toBe(true)
    // …while new traffic uses the new generation.
    expect(verifyFrankingTag(ciphertext, rotated, FRANK_KEY)).toBe(true)
    // Cross-generation checks fail: v1 tag under v2 key.
    expect(verifyFrankingTag(ciphertext, oldTag, FRANK_KEY)).toBe(false)
  })

  it('tag envelope stays compact (mac is truncated to 16 bytes)', () => {
    const tag = attachFrankingTag(ciphertext, FRANK_KEY, 'frank-v1')
    expect(tag.mac).toHaveLength(FRANKING_MAC_BYTES * 2)
    expect(tag.nonce).toHaveLength(24)
  })

  it('requires a non-empty keyId and key', () => {
    expect(() => attachFrankingTag(ciphertext, FRANK_KEY, '')).toThrow(/keyId/)
    expect(() => attachFrankingTag(ciphertext, '', 'frank-v1')).toThrow(/empty/)
  })
})
