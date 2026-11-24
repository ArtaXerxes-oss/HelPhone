import { afterEach, describe, expect, it } from 'vitest'
import { piiSaltSet, pseudonymCandidates, pseudonymize } from '../server/lib/redact.js'

const saved = { ...process.env }
afterEach(() => { process.env = { ...saved } })

describe('PII salt rotation', () => {
  it('writes only the active version and reads through the overlap set', () => {
    process.env.PII_HMAC_SALTS = 'v2:new-secret,v1:old-secret'
    process.env.PII_HMAC_ACTIVE_VERSION = 'v2'
    process.env.PII_HMAC_REQUIRED_VERSION = 'v2'
    expect(pseudonymize('alice@example.org')).toMatch(/^hmac:v2:/)
    expect(pseudonymCandidates('alice@example.org')).toHaveLength(2)
  })

  it('blocks writes when a deployment has only partially rotated', () => {
    process.env.PII_HMAC_SALTS = 'v1:old-secret'
    process.env.PII_HMAC_ACTIVE_VERSION = 'v1'
    process.env.PII_HMAC_REQUIRED_VERSION = 'v2'
    expect(() => piiSaltSet()).toThrow(/rotation incomplete/)
  })
})
