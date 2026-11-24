import { describe, expect, it } from 'vitest'
import { SLICE_ORDER } from '../src/components/sections/index.ts'
import { colors, motion } from '../src/theme/tokens.ts'

describe('ISP-100 strangler pilot (#770)', () => {
  it('sequences nav and hero as the first extracted slices', () => {
    expect(SLICE_ORDER[0].id).toBe('nav')
    expect(SLICE_ORDER[0].status).toBe('extracted')
    expect(SLICE_ORDER[1].id).toBe('hero')
    expect(SLICE_ORDER[1].status).toBe('extracted')
    expect(SLICE_ORDER.at(-1).id).toBe('help')
    expect(SLICE_ORDER.at(-1).status).toBe('planned-last')
  })

  it('keeps brand tokens centralised (no ad-hoc coral/cream drift)', () => {
    expect(colors.coral).toBe('#FF7A6B')
    expect(colors.cream).toBe('#ECE0CC')
    expect(colors.background).toBe('#1c2c24')
    expect(motion.revealFallbackMs).toBe(4500)
  })
})
