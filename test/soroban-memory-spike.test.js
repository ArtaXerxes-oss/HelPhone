import { describe, expect, it } from 'vitest'

const HOST_REFERENCE_BYTES = 64 * 1024 * 1024
const estimatePeak = (entries, bytesPerEntry) => entries * bytesPerEntry * 3

describe('Soroban linear-memory bounds (#578)', () => {
  it('keeps the 500-entry, 1 KiB model below half the reference cap', () => {
    expect(estimatePeak(500, 1024)).toBeLessThan(HOST_REFERENCE_BYTES / 2)
  })
  it('demonstrates why large monolithic vectors require pagination', () => {
    expect(estimatePeak(500, 64 * 1024)).toBeGreaterThan(HOST_REFERENCE_BYTES)
  })
})
