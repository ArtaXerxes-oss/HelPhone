import { describe, expect, it, beforeEach } from 'vitest'
import { detectScript, normalizeSearchQuery, levenshtein } from '../src/lib/searchNormalize.ts'
import { clearGeocoderCache, searchCitiesSync } from '../src/lib/geocoder.ts'

describe('ISP-101 multilingual search (#771)', () => {
  beforeEach(() => {
    clearGeocoderCache()
  })

  it('detects arabic and cjk scripts', () => {
    expect(detectScript('القاهرة')).toBe('arabic')
    expect(detectScript('東京')).toBe('cjk')
    expect(detectScript('Cairo')).toBe('latin')
  })

  it('normalises arabic alef variants without wiping the word', () => {
    const a = normalizeSearchQuery('القاهرة')
    const b = normalizeSearchQuery('القاهره') // alef maqsura / yeh noise path
    expect(a.length).toBeGreaterThan(3)
    expect(levenshtein(a, b)).toBeLessThanOrEqual(2)
  })

  it('keeps CJK queries matching exact aliases in the top hits', () => {
    const hits = searchCitiesSync('東京', { limit: 5 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].text).toBe('Tokyo')
  })

  it('matches arabic cairo alias', () => {
    const hits = searchCitiesSync('القاهرة', { limit: 5 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].text).toBe('Cairo')
  })

  it('preserves latin typo tolerance', () => {
    const hits = searchCitiesSync('Londn', { limit: 5 })
    expect(hits.some((h) => h.text === 'London')).toBe(true)
  })
})
