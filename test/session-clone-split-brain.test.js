import { beforeEach, describe, expect, it } from 'vitest'
import {
  createTransferTicket,
  redeemTransferTicket,
  __resetRedeemedTicketsForTests,
} from '../src/lib/sessionKey.js'
import {
  admitClaim,
  claimGeneration,
  mintRestoredGeneration,
  promoteRedeemedTicket,
  __resetSessionGenerationsForTests,
} from '../src/lib/sessionGenerations.ts'

// CI gate for dual dispatch (#922). A responder session must have exactly one
// device that can accept new claims at any time. If two devices end up live on
// the same generation, the second one must be refused.

const SOURCE = { sessionId: 'sess-split', generation: 3, deviceId: 'device-A' }

/** Hand the session from the source device to a destination through a redeemed ticket. */
function transferTo(deviceId) {
  const ticket = createTransferTicket(SOURCE)
  const redeemed = redeemTransferTicket(ticket, { destinationDeviceId: deviceId })
  return { ticket, redeemed, promoted: redeemed.ok ? promoteRedeemedTicket(redeemed) : null }
}

describe('session-clone-split-brain', () => {
  beforeEach(() => {
    __resetRedeemedTicketsForTests()
    __resetSessionGenerationsForTests()
    expect(claimGeneration(SOURCE)).toEqual({ ok: true })
  })

  it('the source device stops dispatching once the ticket is redeemed elsewhere', () => {
    const { promoted } = transferTo('device-B')
    expect(promoted.ok).toBe(true)
    expect(admitClaim(SOURCE)).toEqual({ ok: false, error: 'generation_revoked' })
    expect(admitClaim({ sessionId: SOURCE.sessionId, generation: 4, deviceId: 'device-B' })).toEqual({ ok: true })
  })

  it('dual dispatch is refused: a second device presenting the live generation fails as split brain', () => {
    transferTo('device-B')
    const clone = { sessionId: SOURCE.sessionId, generation: 4, deviceId: 'device-C' }
    expect(admitClaim(clone)).toEqual({ ok: false, error: 'split_brain' })
  })

  it('a replayed ticket cannot create a second live holder', () => {
    const { ticket } = transferTo('device-B')
    expect(redeemTransferTicket(ticket, { destinationDeviceId: 'device-C' })).toEqual({
      ok: false,
      error: 'already_redeemed',
    })
    // Even if the replay were applied, the ledger refuses the same generation again.
    const replay = promoteRedeemedTicket({ sessionId: SOURCE.sessionId, generation: 4, deviceId: 'device-C' })
    expect(replay).toEqual({ ok: false, error: 'stale_generation' })
    expect(admitClaim({ sessionId: SOURCE.sessionId, generation: 4, deviceId: 'device-B' })).toEqual({ ok: true })
  })

  it('a key restored on another device supersedes the transferred holder rather than running beside it', () => {
    transferTo('device-B')
    const restored = mintRestoredGeneration({ sessionId: SOURCE.sessionId, backupGeneration: 3, deviceId: 'device-C' })
    expect(restored.generation).toBe(5)
    expect(admitClaim({ sessionId: SOURCE.sessionId, generation: 4, deviceId: 'device-B' })).toEqual({
      ok: false,
      error: 'generation_revoked',
    })
    expect(admitClaim({ sessionId: SOURCE.sessionId, generation: 5, deviceId: 'device-C' })).toEqual({ ok: true })
  })

  it('the same device re-presenting its live generation is not a split brain', () => {
    transferTo('device-B')
    const live = { sessionId: SOURCE.sessionId, generation: 4, deviceId: 'device-B' }
    expect(admitClaim(live)).toEqual({ ok: true })
    expect(admitClaim(live)).toEqual({ ok: true })
  })
})
