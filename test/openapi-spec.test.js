import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('OpenAPI Spec Conformance (#814 / ISP-144)', () => {
  it('validates that swagger.json contains complete OpenAPI 3.0 federation endpoints', () => {
    const swaggerPath = path.resolve(process.cwd(), 'swagger.json')
    expect(fs.existsSync(swaggerPath)).toBe(true)

    const raw = fs.readFileSync(swaggerPath, 'utf8')
    const spec = JSON.parse(raw)

    expect(spec.openapi).toMatch(/^3\.0/)
    expect(spec.info.title).toContain('HelPhone')
    expect(spec.paths).toBeDefined()

    // Required federation endpoints
    expect(spec.paths['/api/federation/trust-bundle']).toBeDefined()
    expect(spec.paths['/api/federation/trust-bundle/gossip']).toBeDefined()
    expect(spec.paths['/api/federation/dispatch']).toBeDefined()
    expect(spec.paths['/api/federation/ack']).toBeDefined()
    expect(spec.paths['/api/federation/sync']).toBeDefined()
    expect(spec.paths['/api/federation/settlement']).toBeDefined()
    expect(spec.paths['/api/federation/status']).toBeDefined()
    expect(spec.paths['/api/history/timeline/{requestId}']).toBeDefined()

    // Required schemas
    expect(spec.components?.schemas?.TrustBundle).toBeDefined()
    expect(spec.components?.schemas?.FederatedEnvelope).toBeDefined()
    expect(spec.components?.schemas?.CrossInstanceIou).toBeDefined()
  })
})
