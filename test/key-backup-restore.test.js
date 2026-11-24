import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { backupPrivateKey, restoreSessionFromShards } from '../src/lib/keyBackup.ts'
import {
  admitClaim,
  claimGeneration,
  promoteRedeemedTicket,
  revokeGeneration,
  __resetSessionGenerationsForTests,
} from '../src/lib/sessionGenerations.ts'

// #923: restoring guardian shards always mints a new generation and never
// resurrects a revoked one. PBKDF2 (210k iterations) makes each case take a
// moment, so the timeout is raised.
const TIMEOUT = 60_000
const SESSION = 'sess-restore'
const PASSPHRASE = 'correct horse battery staple'
const KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff)

describe('key-backup restore mints a fresh generation (#923)', () => {
  let shards

  beforeAll(async () => {
    shards = await backupPrivateKey(KEY, PASSPHRASE)
  }, TIMEOUT)

  beforeEach(() => {
    __resetSessionGenerationsForTests()
  })

  it('recovers the key from any two guardian shards and mints the next generation', async () => {
    const restored = await restoreSessionFromShards([shards[0], shards[2]], PASSPHRASE, {
      sessionId: SESSION,
      backupGeneration: 0,
      deviceId: 'device-R',
    })
    expect(restored.ok).toBe(true)
    expect(Array.from(restored.privateKey)).toEqual(Array.from(KEY))
    expect(restored.identity).toEqual({ sessionId: SESSION, generation: 1, deviceId: 'device-R' })
  }, TIMEOUT)

  it('a restore after a transfer yields a new generation, and the revoked holders cannot claim', async () => {
    claimGeneration({ sessionId: SESSION, generation: 0, deviceId: 'device-A' })
    promoteRedeemedTicket({ sessionId: SESSION, generation: 1, deviceId: 'device-B' })

    const restored = await restoreSessionFromShards([shards[0], shards[1]], PASSPHRASE, {
      sessionId: SESSION,
      backupGeneration: 0,
      deviceId: 'device-C',
    })
    expect(restored.ok).toBe(true)
    expect(restored.identity.generation).toBe(2)

    expect(admitClaim({ sessionId: SESSION, generation: 0, deviceId: 'device-A' })).toEqual({
      ok: false,
      error: 'generation_revoked',
    })
    expect(admitClaim({ sessionId: SESSION, generation: 1, deviceId: 'device-B' })).toEqual({
      ok: false,
      error: 'generation_revoked',
    })
    expect(admitClaim(restored.identity)).toEqual({ ok: true })
  }, TIMEOUT)

  it('never resurrects a revoked generation, even when the backup records it', async () => {
    claimGeneration({ sessionId: SESSION, generation: 5, deviceId: 'device-A' })
    revokeGeneration(SESSION, 5)

    const restored = await restoreSessionFromShards([shards[1], shards[2]], PASSPHRASE, {
      sessionId: SESSION,
      backupGeneration: 5,
      deviceId: 'device-R',
    })
    expect(restored.ok).toBe(true)
    expect(restored.identity.generation).toBe(6)
    expect(admitClaim({ sessionId: SESSION, generation: 5, deviceId: 'device-A' })).toEqual({
      ok: false,
      error: 'generation_revoked',
    })
  }, TIMEOUT)

  it('race window: concurrent restores get distinct generations, and the earlier one is superseded', async () => {
    claimGeneration({ sessionId: SESSION, generation: 0, deviceId: 'device-A' })

    const [first, second] = await Promise.all([
      restoreSessionFromShards([shards[0], shards[1]], PASSPHRASE, {
        sessionId: SESSION,
        backupGeneration: 0,
        deviceId: 'device-R1',
      }),
      restoreSessionFromShards([shards[1], shards[2]], PASSPHRASE, {
        sessionId: SESSION,
        backupGeneration: 0,
        deviceId: 'device-R2',
      }),
    ])
    expect(first.ok && second.ok).toBe(true)

    const generations = [first.identity.generation, second.identity.generation].sort()
    expect(generations).toEqual([1, 2])

    const [earlier, later] =
      first.identity.generation < second.identity.generation ? [first, second] : [second, first]
    expect(admitClaim(earlier.identity)).toEqual({ ok: false, error: 'generation_revoked' })
    expect(admitClaim(later.identity)).toEqual({ ok: true })
  }, TIMEOUT)

  it('a wrong passphrase fails and mints nothing, so the next valid restore still gets the next generation', async () => {
    await expect(
      restoreSessionFromShards([shards[0], shards[1]], 'wrong passphrase', {
        sessionId: SESSION,
        backupGeneration: 0,
        deviceId: 'device-R',
      }),
    ).rejects.toThrow()

    const restored = await restoreSessionFromShards([shards[0], shards[1]], PASSPHRASE, {
      sessionId: SESSION,
      backupGeneration: 0,
      deviceId: 'device-R',
    })
    expect(restored.identity.generation).toBe(1)
  }, TIMEOUT)

  it('refuses to restore from fewer than two shards', async () => {
    await expect(
      restoreSessionFromShards([shards[0]], PASSPHRASE, { sessionId: SESSION, backupGeneration: 0, deviceId: 'd' }),
    ).rejects.toThrow('At least 2 guardian shards')
  }, TIMEOUT)
})
