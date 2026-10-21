import { describe, expect, it } from 'vitest'
import {
  annotateLeaderboard,
  filterGamingEvents,
  reduceRanking,
} from '../src/lib/rankingIntegrity.ts'

describe('ISP-102 ranking integrity (#772)', () => {
  it('rejects self-dealing completions', () => {
    const { accepted, rejected } = filterGamingEvents([
      {
        id: '1',
        responderId: 'B',
        requesterId: 'B',
        kind: 'completion',
        at: 1_000,
      },
    ])
    expect(accepted).toHaveLength(0)
    expect(rejected).toHaveLength(1)
  })

  it('caps upvotes per pair per day', () => {
    const day = Date.UTC(2026, 9, 18, 12)
    const events = Array.from({ length: 6 }, (_, i) => ({
      id: `u${i}`,
      responderId: 'hero',
      requesterId: 'fan',
      kind: 'upvote',
      at: day + i * 1000,
    }))
    const { accepted, rejected } = filterGamingEvents(events)
    expect(accepted).toHaveLength(3)
    expect(rejected).toHaveLength(3)
  })

  it('blocks a scripted farm from topping a proven responder', () => {
    const base = Date.UTC(2026, 9, 18, 10)
    const farm = Array.from({ length: 12 }, (_, i) => ({
      id: `farm-${i}`,
      responderId: 'farmer',
      requesterId: `sock-${i}`,
      kind: 'completion',
      at: base + i * 30_000, // faster than min gap when unproven
      proofValid: false,
      deviceId: 'same-device',
      ipHash: 'same-ip',
    }))
    const legit = [
      {
        id: 'real-1',
        responderId: 'medic',
        requesterId: 'neighbour',
        kind: 'completion',
        at: base,
        proofValid: true,
      },
      {
        id: 'real-2',
        responderId: 'medic',
        requesterId: 'neighbour-2',
        kind: 'completion',
        at: base + 20 * 60_000,
        proofValid: true,
      },
      {
        id: 'real-3',
        responderId: 'medic',
        requesterId: 'neighbour-3',
        kind: 'completion',
        at: base + 40 * 60_000,
        proofValid: true,
      },
    ]
    const ranked = reduceRanking([...farm, ...legit])
    expect(ranked[0].responderId).toBe('medic')
    expect(ranked[0].tier).toBe('proven')
    const farmer = ranked.find((r) => r.responderId === 'farmer')
    expect(!farmer || farmer.tier === 'quarantined' || farmer.score < ranked[0].score).toBe(true)
  })

  it('keeps newcomers visible as probationary on the chain leaderboard', () => {
    const rows = annotateLeaderboard([
      { responder: 'GABCNEWCOMERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', total_arrivals: 1 },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].tier).toBe('probationary')
  })

  it('reduceRanking is deterministic', () => {
    const events = [
      {
        id: 'a',
        responderId: 'r1',
        requesterId: 'q1',
        kind: 'completion',
        at: 100,
        proofValid: true,
      },
      {
        id: 'b',
        responderId: 'r2',
        requesterId: 'q2',
        kind: 'completion',
        at: 200,
        proofValid: true,
      },
    ]
    const a = reduceRanking(events)
    const b = reduceRanking([...events].reverse())
    expect(a).toEqual(b)
  })
})
