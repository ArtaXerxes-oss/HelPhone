import { beforeEach, describe, expect, it } from 'vitest'
import { PRIO, clearQueue, configureRetention, enqueue, lockOutbox, queueDepth } from '../src/lib/field/offlineQueue'
import {
  claimGeneration,
  revokeGeneration,
  __resetSessionGenerationsForTests,
} from '../src/lib/sessionGenerations.ts'

// #923: an outbox write that is made on behalf of a session must come from the
// live generation. A revoked generation may drain, but it cannot add new claims.
const LIVE = { sessionId: 'sess-outbox', generation: 0, deviceId: 'device-A' }

describe('outbox writes are gated by the live generation (#923)', () => {
  beforeEach(() => {
    lockOutbox()
    localStorage.clear()
    configureRetention({ maxItems: 200, maxAgeMs: 7 * 24 * 60 * 60 * 1000 })
    clearQueue()
    __resetSessionGenerationsForTests()
  })

  it('refuses a write from a revoked generation and stores nothing', () => {
    claimGeneration(LIVE)
    revokeGeneration(LIVE.sessionId, LIVE.generation)
    const before = queueDepth()

    const result = enqueue({ kind: 'sos', prio: PRIO.SOS, session: LIVE })

    expect(result).toEqual({ entry: null, duplicate: false, refused: 'generation_revoked', redactedFields: [] })
    expect(queueDepth()).toBe(before)
  })

  it('accepts a write from the live generation', () => {
    claimGeneration(LIVE)
    const result = enqueue({ kind: 'sos', prio: PRIO.SOS, session: LIVE })
    expect(result.refused).toBeUndefined()
    expect(result.entry).toMatchObject({ kind: 'sos' })
  })

  it('callers that pass no session keep the previous behaviour', () => {
    const result = enqueue({ kind: 'sos', prio: PRIO.SOS })
    expect(result.refused).toBeUndefined()
    expect(result.entry).toMatchObject({ kind: 'sos' })
  })
})
