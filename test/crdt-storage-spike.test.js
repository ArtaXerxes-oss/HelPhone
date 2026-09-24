import { describe, expect, it } from 'vitest'
import { LwwElementSet, stableVector } from '../src/lib/crdt'
describe('LWW-element-set storage spike (#580)', () => {
  it('measures 10,000 offline mutations and prunes superseded operations', () => {
    const doc = new LwwElementSet('phone-a')
    for (let i = 0; i < 10_000; i++) doc.set(`request-${i % 100}`, { revision: i }, i)
    const before = doc.storageBytes
    expect(doc.prune({ 'phone-a': 10_000 })).toBe(9_900)
    expect(doc.storageBytes).toBeLessThan(before / 10)
  })
  it('converges under opposite replay orders', () => {
    const a = new LwwElementSet('a'); const b = new LwwElementSet('b')
    const ops = [a.set('x', 1, 10), b.set('x', 2, 10), a.delete('y', 11), b.set('z', 3, 12)]
    const left = new LwwElementSet('left'); const right = new LwwElementSet('right')
    left.merge(ops); right.merge([...ops].reverse())
    expect(left.values()).toEqual(right.values())
    expect(left.snapshot().entries).toEqual(right.snapshot().entries)
  })
  it('computes the causal stability frontier', () => {
    expect(stableVector([{ a: 4, b: 2 }, { a: 3, b: 5 }])).toEqual({ a: 3, b: 2 })
  })
})
