import { describe, it, expect } from 'vitest'
import {
  classifyFinality,
  isOrphaned,
  DEFAULT_FINALITY_DEPTH,
} from '../server/lib/finality.ts'

describe('checkpoint finality tiers (ISP-057 / #727)', () => {
  it('depth 0 is pending — first-sight is never treated as final', () => {
    expect(classifyFinality(0)).toBe('pending')
  })

  it('depth below k is closed — informational, reversible', () => {
    expect(classifyFinality(1)).toBe('closed')
    expect(classifyFinality(1, { finalityDepth: 5 })).toBe('closed')
  })

  it('depth >= k is finalized — the tier that gates aid release', () => {
    expect(classifyFinality(DEFAULT_FINALITY_DEPTH)).toBe('finalized')
    expect(classifyFinality(10)).toBe('finalized')
    expect(classifyFinality(4, { finalityDepth: 5 })).toBe('closed')
    expect(classifyFinality(5, { finalityDepth: 5 })).toBe('finalized')
  })

  it('throws on negative or non-numeric depths instead of guessing a tier', () => {
    expect(() => classifyFinality(-1)).toThrow(RangeError)
    expect(() => classifyFinality(NaN)).toThrow(RangeError)
    expect(() => classifyFinality('deep' )).toThrow(RangeError)
  })

  it('flags orphaned siblings: same ledger, different hash', () => {
    const first = { ledger: 812341, ledgerHash: 'aaa' }
    const diverged = { ledger: 812341, ledgerHash: 'bbb' }
    expect(isOrphaned(first, diverged)).toBe(true)
  })

  it('does not flag distinct-ledger sightings as orphans', () => {
    const first = { ledger: 812341, ledgerHash: 'aaa' }
    const next = { ledger: 812342, ledgerHash: 'bbb' }
    expect(isOrphaned(first, next)).toBe(false)
    expect(isOrphaned(first, first)).toBe(false)
  })
})
