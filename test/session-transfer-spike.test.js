import { describe, it, expect, beforeEach } from 'vitest'
import {
  createTransferTicket,
  redeemTransferTicket,
  __resetRedeemedTicketsForTests,
} from '../src/lib/sessionKey.js'

const IDENTITY = { sessionId: 'sess-1', generation: 3, deviceId: 'device-A' }

describe('cross-device transfer ticket (ISP-058 / #728)', () => {
  beforeEach(() => {
    __resetRedeemedTicketsForTests()
  })

  it('redeems once: destination becomes generation N+1', () => {
    const ticket = createTransferTicket(IDENTITY)
    const result = redeemTransferTicket(ticket, { destinationDeviceId: 'device-B' })
    expect(result).toEqual({ ok: true, sessionId: 'sess-1', generation: 4, deviceId: 'device-B' })
  })

  it('replaying a redeemed ticket fails with already_redeemed', () => {
    const ticket = createTransferTicket(IDENTITY)
    expect(redeemTransferTicket(ticket, { destinationDeviceId: 'device-B' }).ok).toBe(true)
    const replay = redeemTransferTicket(ticket, { destinationDeviceId: 'device-C' })
    expect(replay).toEqual({ ok: false, error: 'already_redeemed' })
  })

  it('an expired ticket fails deterministically', () => {
    const now = Date.now()
    const ticket = createTransferTicket(IDENTITY, { ttlMs: 60_000, now })
    const result = redeemTransferTicket(ticket, {
      destinationDeviceId: 'device-B',
      now: now + 60_001,
    })
    expect(result).toEqual({ ok: false, error: 'expired' })
  })

  it('a redeemed expired ticket reports already_redeemed (replay beats expiry)', () => {
    const now = Date.now()
    const ticket = createTransferTicket(IDENTITY, { ttlMs: 1, now })
    expect(redeemTransferTicket(ticket, { destinationDeviceId: 'device-B', now }).ok).toBe(true)
    const replay = redeemTransferTicket(ticket, { destinationDeviceId: 'device-C', now: now + 10_000 })
    expect(replay).toEqual({ ok: false, error: 'already_redeemed' })
  })

  it('rejects malformed tickets and missing destination', () => {
    expect(redeemTransferTicket(null, { destinationDeviceId: 'B' })).toEqual({ ok: false, error: 'malformed' })
    expect(redeemTransferTicket({ ...IDENTITY, generation: -1 }, { destinationDeviceId: 'B' })).toEqual({ ok: false, error: 'malformed' })
    const ticket = createTransferTicket(IDENTITY)
    expect(redeemTransferTicket(ticket, { destinationDeviceId: '' })).toEqual({ ok: false, error: 'malformed' })
  })

  it('ticket carries single-use nonce and bounded validity', () => {
    const now = Date.now()
    const ticket = createTransferTicket(IDENTITY, { ttlMs: 90_000, now })
    expect(ticket.nonce).toHaveLength(32)
    expect(ticket.expiresAt).toBe(now + 90_000)
    const other = createTransferTicket(IDENTITY, { now })
    expect(other.ticketId).not.toBe(ticket.ticketId)
    expect(other.nonce).not.toBe(ticket.nonce)
  })
})
