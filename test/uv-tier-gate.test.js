import { beforeEach, describe, expect, it } from 'vitest'

process.env.SESSION_SECRET = 'test-secret-at-least-32-characters-long!!'

const { issueSession, __resetSessionsForTests } = await import('../server/lib/session-store.js')
const { verifyBearerSession } = await import('../server/middleware/auth.ts')
const { hasUvTier, requireUvTier, UV_TIER_INSUFFICIENT } = await import('../server/middleware/uvTier.ts')
const { resolvers } = await import('../server/graphql/resolvers.ts')

// #924 / ADR-026: sensitive actions need a UV-verified passkey session. A
// limited session is refused, and a UV-verified login upgrades the user without
// re-registration.

function fakeResponse() {
  const res = { statusCode: null, body: null }
  res.status = (code) => {
    res.statusCode = code
    return res
  }
  res.json = (payload) => {
    res.body = payload
    return res
  }
  return res
}

function runGate(user) {
  const req = { authenticatedUser: user }
  const res = fakeResponse()
  let nextCalled = false
  requireUvTier(req, res, () => {
    nextCalled = true
  })
  return { res, nextCalled }
}

describe('UV-tier gate (#924, ADR-026)', () => {
  beforeEach(() => {
    __resetSessionsForTests()
  })

  describe('hasUvTier fails closed', () => {
    it('is true only for an explicit uv === true claim', () => {
      expect(hasUvTier({ uv: true })).toBe(true)
      expect(hasUvTier({ uv: false })).toBe(false)
      expect(hasUvTier({ uv: 'true' })).toBe(false)
      expect(hasUvTier({ uv: 1 })).toBe(false)
      expect(hasUvTier({})).toBe(false)
      expect(hasUvTier(undefined)).toBe(false)
      expect(hasUvTier(null)).toBe(false)
    })
  })

  describe('requireUvTier', () => {
    it('refuses a UV-less session with 403 uv_tier_insufficient and does not call next', () => {
      const { res, nextCalled } = runGate({ id: 'user-1', algorithm: 'webauthn', uv: false })
      expect(res.statusCode).toBe(403)
      expect(res.body).toEqual({ success: false, error: UV_TIER_INSUFFICIENT })
      expect(nextCalled).toBe(false)
    })

    it('refuses a request with no authenticated user', () => {
      const { res, nextCalled } = runGate(undefined)
      expect(res.statusCode).toBe(403)
      expect(nextCalled).toBe(false)
    })

    it('admits a UV-verified session', () => {
      const { res, nextCalled } = runGate({ id: 'user-1', algorithm: 'webauthn', uv: true })
      expect(nextCalled).toBe(true)
      expect(res.statusCode).toBeNull()
    })
  })

  describe('end to end through the session store', () => {
    it('a limited session is refused on a sensitive route', async () => {
      const token = await issueSession('user-1', 'responder-a', { uv: false })
      const result = await verifyBearerSession(token)
      expect(result.ok).toBe(true)
      expect(result.user.uv).toBe(false)
      expect(runGate(result.user).nextCalled).toBe(false)
    })

    it('a UV-verified login upgrades the same user without re-registration', async () => {
      const limited = await issueSession('user-1', 'responder-a', { uv: false })
      expect(runGate((await verifyBearerSession(limited)).user).nextCalled).toBe(false)

      // The passkey login/verify path mints a new session from the authenticator's UV answer.
      const upgraded = await issueSession('user-1', 'responder-a', { uv: true })
      const result = await verifyBearerSession(upgraded)
      expect(result.ok).toBe(true)
      expect(result.user).toMatchObject({ id: 'user-1', algorithm: 'webauthn', uv: true })
      expect(runGate(result.user).nextCalled).toBe(true)
    })

    it('the limited session stays refused after the upgrade, since sessions are independent', async () => {
      const limited = await issueSession('user-1', 'responder-a', { uv: false })
      await issueSession('user-1', 'responder-a', { uv: true })
      expect(runGate((await verifyBearerSession(limited)).user).nextCalled).toBe(false)
    })
  })

  describe('GraphQL sensitive mutations (session callers only)', () => {
    const args = { input: { incidentId: 'INC-1', baseVersion: 1, patch: {} } }
    const storeStub = { syncFlush: () => ({ __typename: 'SyncConflict', incidentId: 'INC-1' }) }

    it('refuses a UV-less passkey session with a 403 extension code', async () => {
      const context = { user: { id: 'user-1', algorithm: 'webauthn', uv: false }, store: storeStub }
      await expect(resolvers.Mutation.syncFlush(null, args, context)).rejects.toMatchObject({
        extensions: { code: UV_TIER_INSUFFICIENT, http: { status: 403 } },
      })
    })

    it('admits a UV-verified passkey session', async () => {
      const context = { user: { id: 'user-1', algorithm: 'webauthn', uv: true }, store: storeStub }
      await expect(resolvers.Mutation.syncFlush(null, args, context)).resolves.toMatchObject({
        __typename: 'SyncConflict',
      })
    })

    it('leaves anonymous callers (the field sync path) unchanged', async () => {
      const context = { user: null, store: storeStub }
      await expect(resolvers.Mutation.syncFlush(null, args, context)).resolves.toMatchObject({
        __typename: 'SyncConflict',
      })
    })
  })
})
