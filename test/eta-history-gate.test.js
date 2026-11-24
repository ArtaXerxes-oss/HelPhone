import { describe, it, expect } from 'vitest'
import { estimateEta, estimateEtaWhileSyncing } from '../src/lib/etaEstimate.ts'

describe('estimateEtaWhileSyncing (#932)', () => {
  it('withholds the ETA while history is still partial', () => {
    const input = { distanceKm: 4, source: 'traffic' }
    expect(estimateEtaWhileSyncing(input, { actionableComplete: false })).toBeNull()
  })

  it('returns the normal estimate once actionable state is complete', () => {
    const input = { distanceKm: 4, source: 'fallback' }
    expect(estimateEtaWhileSyncing(input, { actionableComplete: true })).toEqual(estimateEta(input))
  })
})
