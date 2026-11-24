import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildCloneAttemptAudit,
  dailyPseudonym,
  emitCloneAttemptAlert,
} from '../server/lib/cloneAttemptAudit.ts'

// #922: a clone attempt is audited without location PII. The DID is used only
// to derive a daily pseudonym, so neither the audit record nor the alert body
// may contain it.
const SECRET = 'clone-audit-secret-at-least-32-characters-long'
const DID = 'GCRESPONDERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const OBSERVED = new Date('2026-11-22T10:15:00Z')

function observation(overrides = {}) {
  return { did: DID, requestId: 'req-42', distinctClaims: 2, observedAt: OBSERVED, ...overrides }
}

describe('clone-attempt audit (#922)', () => {
  let savedWebhook

  beforeEach(() => {
    savedWebhook = process.env.ALERT_WEBHOOK_URL
    delete process.env.ALERT_WEBHOOK_URL
  })

  afterEach(() => {
    if (savedWebhook === undefined) delete process.env.ALERT_WEBHOOK_URL
    else process.env.ALERT_WEBHOOK_URL = savedWebhook
  })

  it('the audit record carries only allowlisted metadata', () => {
    const audit = buildCloneAttemptAudit(observation(), { secret: SECRET })
    expect(Object.keys(audit).sort()).toEqual(['day', 'distinctClaims', 'observedAt', 'pseudonym', 'requestId', 'type'])
    expect(audit).toMatchObject({
      type: 'session_clone_attempt',
      day: '2026-11-22',
      requestId: 'req-42',
      distinctClaims: 2,
      observedAt: '2026-11-22T10:15:00.000Z',
    })
    expect(JSON.stringify(audit)).not.toContain(DID)
  })

  it('the pseudonym is stable within a UTC day and unlinkable across days', () => {
    const today = dailyPseudonym(DID, '2026-11-22', SECRET)
    expect(dailyPseudonym(DID, '2026-11-22', SECRET)).toBe(today)
    expect(dailyPseudonym(DID, '2026-11-23', SECRET)).not.toBe(today)
    expect(today).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })

  it('the pseudonym depends on the secret, so it cannot be recomputed from the DID alone', () => {
    const other = `${SECRET}-rotated-x`
    expect(dailyPseudonym(DID, '2026-11-22', other)).not.toBe(dailyPseudonym(DID, '2026-11-22', SECRET))
  })

  it('normalises the DID before hashing, so case and whitespace do not split one responder', () => {
    expect(dailyPseudonym(`  ${DID.toLowerCase()} `, '2026-11-22', SECRET)).toBe(dailyPseudonym(DID, '2026-11-22', SECRET))
  })

  it('needs at least two distinct claims to count as a clone attempt', () => {
    expect(() => buildCloneAttemptAudit(observation({ distinctClaims: 1 }), { secret: SECRET })).toThrow(
      'at least two distinct claims',
    )
  })

  it('refuses a secret shorter than 32 characters', () => {
    expect(() => dailyPseudonym(DID, '2026-11-22', 'short')).toThrow('at least 32 characters')
  })

  it('pages on call with a metadata-only alert', async () => {
    const audit = buildCloneAttemptAudit(observation(), { secret: SECRET })
    const sent = []
    const fetchStub = async (url, init) => {
      sent.push({ url, init })
      return { ok: true, status: 200 }
    }

    const delivered = await emitCloneAttemptAlert(audit, {
      webhookUrl: 'https://alerts.example.test/hook',
      fetch: fetchStub,
    })

    expect(delivered).toBe(true)
    expect(sent).toHaveLength(1)
    const body = JSON.parse(sent[0].init.body)
    expect(body).toMatchObject({ rule: 'session_clone_attempt', severity: 'page' })
    expect(body.summary).toContain(audit.pseudonym)
    expect(sent[0].init.body).not.toContain(DID)
  })

  it('reports false, and sends nothing, when no alert webhook is configured', async () => {
    const audit = buildCloneAttemptAudit(observation(), { secret: SECRET })
    const delivered = await emitCloneAttemptAlert(audit, {
      fetch: async () => {
        throw new Error('no request should be made without a webhook')
      },
    })
    expect(delivered).toBe(false)
  })
})
