import { describe, expect, it } from 'vitest'
import { auditSource } from '../scripts/audit-ai-code.js'

describe('AI code security audit #585', () => {
  it('detects common generated-code security defects', () => {
    const findings = auditSource(`
      const apiSecret = 'sk_live_12345678901234567890'
      async function proxy(req) { try { fetch(req.body.url) } catch (error) {} }
      const view = <div dangerouslySetInnerHTML={{__html: req.body.html}} />
      contract.submitTransaction(payload)
      fetch('/api', {}, 'hallucinated')
    `, 'unsafe.tsx')
    expect(findings.map((item) => item.rule)).toEqual(expect.arrayContaining([
      'hardcoded-secret', 'unsanitized-input', 'swallowed-rejection',
      'unsanitized-html', 'unauthenticated-contract-call', 'unverified-api-signature',
    ]))
  })
  it('accepts sanitized, authenticated code', () => {
    expect(auditSource(`async function send(input) { const clean = sanitize(input); await auth.verify(); return contract.submitTransaction(sign(clean)) }`)).toEqual([])
  })
})
