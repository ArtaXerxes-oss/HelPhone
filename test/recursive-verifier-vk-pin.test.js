import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { compareInnerVkHash, PIN_PATH } from '../scripts/check-recursive-verifier-vk.mjs'

const HASH_A = `0x${'a'.repeat(64)}`
const HASH_B = `0x${'b'.repeat(64)}`
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

describe('recursive verifier inner VK pin (#938 / ISP-051)', () => {
  it('passes when the computed hash equals the committed pin', () => {
    const result = compareInnerVkHash({ committed: HASH_A, computed: HASH_A })
    expect(result.ok).toBe(true)
    expect(result.message).toContain(HASH_A)
  })

  it('compares hashes case-insensitively', () => {
    const result = compareInnerVkHash({ committed: HASH_A.toUpperCase().replace('0X', '0x'), computed: HASH_A })
    expect(result.ok).toBe(true)
  })

  it('fails on drift and names both the committed and the computed hash', () => {
    const result = compareInnerVkHash({ committed: HASH_A, computed: HASH_B })
    expect(result.ok).toBe(false)
    expect(result.message).toContain(`committed ${HASH_A}`)
    expect(result.message).toContain(`computed ${HASH_B}`)
  })

  it('fails closed when no pin is committed, and still reports the computed hash', () => {
    const result = compareInnerVkHash({ committed: null, computed: HASH_B })
    expect(result.ok).toBe(false)
    expect(result.message).toContain(HASH_B)
    expect(result.message).toContain('--write')
  })

  it('rejects a malformed committed pin instead of comparing it', () => {
    const result = compareInnerVkHash({ committed: '0x1234', computed: HASH_A })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('malformed')
  })

  it('fails when the VK matches but the circuit artifact sha256 drifted (recompile not reproducible)', () => {
    const result = compareInnerVkHash({
      committed: HASH_A,
      computed: HASH_A,
      committedArtifactSha256: SHA_A,
      computedArtifactSha256: SHA_B,
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain(SHA_A)
    expect(result.message).toContain(SHA_B)
  })

  it('committed pin file is well-formed (hash is null until a reviewed build pins it)', () => {
    const pin = JSON.parse(readFileSync(PIN_PATH, 'utf8'))
    expect(pin.circuit).toBe('responder_credential')
    expect(pin.innerVkFields).toBe(112)
    if (pin.innerVkHash !== null) {
      expect(pin.innerVkHash).toMatch(/^0x[0-9a-f]{64}$/)
    }
  })
})
