import { describe, it, expect, beforeEach } from 'vitest'
import {
  classifyFinality,
  isOrphaned,
  DEFAULT_FINALITY_DEPTH,
  adaptiveFinalityDepth,
  FINALITY_DEPTH_BY_QUALITY,
  getFinalizedRoot,
  updateFinalizedRoot,
  __resetFinalizedRoot,
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

// ── Adaptive finality depth (issue #919) ──────────────────────────────────────

describe('adaptiveFinalityDepth (issue #919 — raise k on RPC degradation)', () => {
  it('returns DEFAULT_FINALITY_DEPTH (2) when RPC quality is good', () => {
    expect(adaptiveFinalityDepth('good')).toBe(DEFAULT_FINALITY_DEPTH)
    expect(adaptiveFinalityDepth('good')).toBe(2)
  })

  it('doubles k to 4 when RPC quality is degraded', () => {
    expect(adaptiveFinalityDepth('degraded')).toBe(4)
    expect(adaptiveFinalityDepth('degraded')).toBeGreaterThan(DEFAULT_FINALITY_DEPTH)
  })

  it('quadruples k to 8 when RPC is offline — maximum caution', () => {
    expect(adaptiveFinalityDepth('offline')).toBe(8)
    expect(adaptiveFinalityDepth('offline')).toBeGreaterThan(adaptiveFinalityDepth('degraded'))
  })

  it('defaults to conservative k=4 when quality is unknown', () => {
    expect(adaptiveFinalityDepth('unknown')).toBe(4)
  })

  it('depth table is strictly non-decreasing: good <= degraded <= offline', () => {
    expect(FINALITY_DEPTH_BY_QUALITY.good).toBeLessThanOrEqual(FINALITY_DEPTH_BY_QUALITY.degraded)
    expect(FINALITY_DEPTH_BY_QUALITY.degraded).toBeLessThanOrEqual(FINALITY_DEPTH_BY_QUALITY.offline)
  })

  it('adaptive k integrates with classifyFinality — same depth becomes closed under degraded RPC', () => {
    const depth = 2
    // at good quality, depth 2 is finalized
    expect(classifyFinality(depth, { finalityDepth: adaptiveFinalityDepth('good') })).toBe('finalized')
    // at degraded quality, depth 2 is only closed (need 4 for finalized)
    expect(classifyFinality(depth, { finalityDepth: adaptiveFinalityDepth('degraded') })).toBe('closed')
  })

  it('a sighting at k=4 is finalized under degraded RPC but needs depth 8 under offline', () => {
    const depth = 4
    expect(classifyFinality(depth, { finalityDepth: adaptiveFinalityDepth('degraded') })).toBe('finalized')
    expect(classifyFinality(depth, { finalityDepth: adaptiveFinalityDepth('offline') })).toBe('closed')
  })
})

// ── Finalized-root registry ────────────────────────────────────────────────────

describe('getFinalizedRoot / updateFinalizedRoot', () => {
  beforeEach(() => { __resetFinalizedRoot() })

  it('returns null before any root has been recorded', () => {
    expect(getFinalizedRoot()).toBeNull()
  })

  it('stores and returns a finalized root with a recordedAt timestamp', () => {
    const before = Date.now()
    const root = updateFinalizedRoot({ ledger: 50000001, ledgerHash: 'abc123def', finalityDepth: 2 })
    const after = Date.now()

    expect(root.ledger).toBe(50000001)
    expect(root.ledgerHash).toBe('abc123def')
    expect(root.finalityDepth).toBe(2)
    const ts = new Date(root.recordedAt).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('getFinalizedRoot returns the last root written by updateFinalizedRoot', () => {
    updateFinalizedRoot({ ledger: 50000001, ledgerHash: 'first', finalityDepth: 2 })
    updateFinalizedRoot({ ledger: 50000010, ledgerHash: 'second', finalityDepth: 4 })
    const root = getFinalizedRoot()
    expect(root?.ledger).toBe(50000010)
    expect(root?.ledgerHash).toBe('second')
    expect(root?.finalityDepth).toBe(4)
  })

  it('records the finalityDepth that was active during confirmation', () => {
    // offline quality → k=8
    const k = adaptiveFinalityDepth('offline')
    updateFinalizedRoot({ ledger: 999, ledgerHash: 'xyz', finalityDepth: k })
    expect(getFinalizedRoot()?.finalityDepth).toBe(8)
  })

  it('__resetFinalizedRoot restores null state for test isolation', () => {
    updateFinalizedRoot({ ledger: 1, ledgerHash: 'h', finalityDepth: 2 })
    __resetFinalizedRoot()
    expect(getFinalizedRoot()).toBeNull()
  })
})
