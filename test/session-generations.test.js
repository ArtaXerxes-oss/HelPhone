import { beforeEach, describe, expect, it } from 'vitest'
import {
  DRAIN_GRACE_MS,
  admitClaim,
  admitDrain,
  claimGeneration,
  mintRestoredGeneration,
  promoteRedeemedTicket,
  revokeGeneration,
  __resetSessionGenerationsForTests,
} from '../src/lib/sessionGenerations.ts'

const SESSION = 'sess-ledger'
const DEVICE_A = { sessionId: SESSION, generation: 0, deviceId: 'device-A' }

describe('session generation ledger (#728 / #922 / #923)', () => {
  beforeEach(() => {
    __resetSessionGenerationsForTests()
  })

  describe('claimGeneration', () => {
    it('registers the first holder and is idempotent for the same device', () => {
      expect(claimGeneration(DEVICE_A)).toEqual({ ok: true })
      expect(claimGeneration(DEVICE_A)).toEqual({ ok: true })
      expect(admitClaim(DEVICE_A)).toEqual({ ok: true })
    })

    it('refuses a second device presenting the same generation (split brain)', () => {
      claimGeneration(DEVICE_A)
      expect(claimGeneration({ ...DEVICE_A, deviceId: 'device-C' })).toEqual({ ok: false, error: 'split_brain' })
    })

    it('never accepts a generation below the highest seen', () => {
      claimGeneration({ ...DEVICE_A, generation: 2 })
      expect(claimGeneration({ ...DEVICE_A, generation: 1 })).toEqual({ ok: false, error: 'stale_generation' })
    })

    it('never accepts a future generation through a bare claim', () => {
      claimGeneration(DEVICE_A)
      expect(claimGeneration({ ...DEVICE_A, generation: 5 })).toEqual({ ok: false, error: 'future_generation' })
    })
  })

  describe('promoteRedeemedTicket (transfer)', () => {
    it('moves the session to N+1 and supersedes the source device', () => {
      claimGeneration({ ...DEVICE_A, generation: 3 })
      const promoted = promoteRedeemedTicket({ sessionId: SESSION, generation: 4, deviceId: 'device-B' })
      expect(promoted).toEqual({ ok: true, sessionId: SESSION, generation: 4, deviceId: 'device-B' })
      expect(admitClaim({ ...DEVICE_A, generation: 3 })).toEqual({ ok: false, error: 'generation_revoked' })
      expect(admitClaim({ sessionId: SESSION, generation: 4, deviceId: 'device-B' })).toEqual({ ok: true })
    })

    it('a second redemption of the same source generation loses the race', () => {
      claimGeneration({ ...DEVICE_A, generation: 3 })
      expect(promoteRedeemedTicket({ sessionId: SESSION, generation: 4, deviceId: 'device-B' }).ok).toBe(true)
      expect(promoteRedeemedTicket({ sessionId: SESSION, generation: 4, deviceId: 'device-C' })).toEqual({
        ok: false,
        error: 'stale_generation',
      })
    })

    it('refuses to skip a generation', () => {
      claimGeneration({ ...DEVICE_A, generation: 3 })
      expect(promoteRedeemedTicket({ sessionId: SESSION, generation: 6, deviceId: 'device-B' })).toEqual({
        ok: false,
        error: 'future_generation',
      })
    })
  })

  describe('mintRestoredGeneration (#923)', () => {
    it('mints above the backup generation when the ledger is empty', () => {
      const minted = mintRestoredGeneration({ sessionId: SESSION, backupGeneration: 0, deviceId: 'device-R' })
      expect(minted.generation).toBe(1)
      expect(admitClaim({ sessionId: SESSION, generation: 1, deviceId: 'device-R' })).toEqual({ ok: true })
    })

    it('never resurrects a revoked generation, even when the backup records it', () => {
      claimGeneration({ ...DEVICE_A, generation: 5 })
      revokeGeneration(SESSION, 5)
      const minted = mintRestoredGeneration({ sessionId: SESSION, backupGeneration: 5, deviceId: 'device-R' })
      expect(minted.generation).toBe(6)
      expect(admitClaim({ ...DEVICE_A, generation: 5 })).toEqual({ ok: false, error: 'generation_revoked' })
    })

    it('rejects a malformed backup generation without touching the ledger', () => {
      claimGeneration(DEVICE_A)
      expect(mintRestoredGeneration({ sessionId: SESSION, backupGeneration: -1, deviceId: 'x' }).ok).toBe(false)
      expect(admitClaim(DEVICE_A)).toEqual({ ok: true })
    })
  })

  describe('admitClaim (new claims)', () => {
    it('reports unknown sessions', () => {
      expect(admitClaim({ sessionId: 'nobody', generation: 0, deviceId: 'x' })).toEqual({
        ok: false,
        error: 'unknown_session',
      })
    })

    it('a revoked generation cannot accept new claims', () => {
      claimGeneration(DEVICE_A)
      revokeGeneration(SESSION, 0)
      expect(admitClaim(DEVICE_A)).toEqual({ ok: false, error: 'generation_revoked' })
    })

    it('a different device on the live generation is refused as split brain', () => {
      claimGeneration(DEVICE_A)
      expect(admitClaim({ ...DEVICE_A, deviceId: 'device-X' })).toEqual({ ok: false, error: 'split_brain' })
    })
  })

  describe('admitDrain (outbox drain without new claims)', () => {
    it('the live holder drains in full', () => {
      claimGeneration(DEVICE_A)
      expect(admitDrain(DEVICE_A)).toEqual({ ok: true, mode: 'full' })
    })

    it('a superseded generation drains only inside the grace window', () => {
      const t0 = 1_000_000
      claimGeneration(DEVICE_A)
      promoteRedeemedTicket({ sessionId: SESSION, generation: 1, deviceId: 'device-B' }, t0)
      expect(admitDrain(DEVICE_A, t0 + 1000)).toEqual({ ok: true, mode: 'drain-only' })
      expect(admitDrain(DEVICE_A, t0 + DRAIN_GRACE_MS + 1)).toEqual({ ok: false, error: 'stale_generation' })
    })

    it('a split-brain duplicate of the live generation drains nothing', () => {
      claimGeneration(DEVICE_A)
      expect(admitDrain({ ...DEVICE_A, deviceId: 'device-X' })).toEqual({ ok: false, error: 'split_brain' })
    })

    it('a generation above the highest seen is refused', () => {
      claimGeneration(DEVICE_A)
      expect(admitDrain({ ...DEVICE_A, generation: 9 })).toEqual({ ok: false, error: 'future_generation' })
    })
  })
})
