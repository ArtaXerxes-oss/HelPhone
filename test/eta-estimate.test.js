import { describe, it, expect } from 'vitest'
import { estimateEta, fatigueMultiplier, rankByRealisticEta } from '../src/lib/etaEstimate.ts'

describe('fatigueMultiplier', () => {
  it('applies no penalty below the threshold', () => {
    expect(fatigueMultiplier(0)).toBe(1)
    expect(fatigueMultiplier(4)).toBe(1)
  })
  it('grows from the threshold and is capped', () => {
    expect(fatigueMultiplier(5)).toBeCloseTo(1.1)
    expect(fatigueMultiplier(7)).toBeCloseTo(1.3)
    expect(fatigueMultiplier(50)).toBe(1.5)
  })
})

describe('estimateEta', () => {
  it('renders fallback ETAs as a low-confidence degraded range', () => {
    const eta = estimateEta({ distanceKm: 10, source: 'fallback' })
    expect(eta.degraded).toBe(true)
    expect(eta.confidence).toBe('low')
    expect(eta.maxMinutes).toBeGreaterThan(eta.minMinutes)
    expect(eta.label).toContain('offline')
  })
  it('never makes fallback output identical in shape to traffic output', () => {
    const traffic = estimateEta({ distanceKm: 10, source: 'traffic' })
    const fallback = estimateEta({ distanceKm: 10, source: 'fallback' })
    expect(traffic.degraded).toBe(false)
    expect(fallback.label).not.toBe(traffic.label)
    expect(fallback.maxMinutes - fallback.minMinutes).toBeGreaterThan(traffic.maxMinutes - traffic.minMinutes)
  })
  it('widens the upper bound for closures', () => {
    const clear = estimateEta({ distanceKm: 10, source: 'fallback' })
    const closed = estimateEta({ distanceKm: 10, source: 'fallback', closurePenalty: 2 })
    expect(closed.maxMinutes).toBeGreaterThan(clear.maxMinutes)
  })
  it('rejects invalid distances', () => {
    expect(() => estimateEta({ distanceKm: -1, source: 'traffic' })).toThrow(RangeError)
  })
})

describe('rankByRealisticEta', () => {
  it('prefers a fresh responder over a closer fatigued one when realistic ETA is lower', () => {
    const ranked = rankByRealisticEta([
      { id: 'fatigued', distanceKm: 4, source: 'traffic', consecutiveRuns: 10 },
      { id: 'fresh', distanceKm: 5, source: 'traffic', consecutiveRuns: 0 },
    ])
    expect(ranked[0].id).toBe('fresh')
  })
  it('keeps the closer responder when both are fresh', () => {
    const ranked = rankByRealisticEta([
      { id: 'far', distanceKm: 9, source: 'traffic' },
      { id: 'near', distanceKm: 2, source: 'traffic' },
    ])
    expect(ranked[0].id).toBe('near')
  })
})
