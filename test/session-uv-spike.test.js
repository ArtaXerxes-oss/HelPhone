import { describe, it, expect, beforeAll } from 'vitest'

process.env.SESSION_SECRET = 'test-secret-at-least-32-characters-long!!'

const { issueSession, verifySessionToken, renewSessionIfNeeded, __resetSessionsForTests } = await import('../server/lib/session-store.js')

describe('session UV tier claims (ISP-059 / #729)', () => {
  beforeAll(() => {
    __resetSessionsForTests()
  })

  it('mints sessions with uv=true by default (UV-verified ceremonies only)', async () => {
    const token = await issueSession('user-1', 'responder-a')
    const claims = await verifySessionToken(token)
    expect(claims.uv).toBe(true)
    expect(claims.sub).toBe('user-1')
  })

  it('preserves an explicit uv=false claim for limited-tier sessions', async () => {
    const token = await issueSession('user-1', 'responder-a', { uv: false })
    const claims = await verifySessionToken(token)
    expect(claims.uv).toBe(false)
  })

  it('session refresh preserves the UV tier of the incoming session', async () => {
    // Short TTL so the session lands inside the renew window.
    const original = await issueSession('user-1', 'responder-a', { uv: false, ttlSeconds: 5 })
    const claims = await verifySessionToken(original)
    const renewed = await renewSessionIfNeeded(original, claims)
    expect(renewed).not.toBeNull()
    const renewedClaims = await verifySessionToken(renewed.token)
    expect(renewedClaims.uv).toBe(false)
    expect(renewedClaims.sub).toBe('user-1')
  })

  it('an upgraded session can carry uv=true after a step-up ceremony', async () => {
    const limited = await issueSession('user-1', 'responder-a', { uv: false, ttlSeconds: 5 })
    const claims = await verifySessionToken(limited)
    const renewed = await renewSessionIfNeeded(limited, claims)
    // Caller re-issues with the measured tier from the step-up ceremony.
    const upgraded = await issueSession(claims.sub, claims.username, { uv: true })
    expect((await verifySessionToken(upgraded)).uv).toBe(true)
    expect((await verifySessionToken(renewed.token)).uv).toBe(false)
  })
})
