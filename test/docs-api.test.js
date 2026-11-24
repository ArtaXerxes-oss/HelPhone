// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  createDocsRouter,
  buildApiReference,
  renderDocsHtml,
  verifyContractDrift,
  redactWalletAddresses,
  containsWalletAddress,
  classifyRouteTier,
  ADR020_TIERS,
} from '../server/routes/docs.ts'

describe('Docs API Reference & ADR-020 Triage (HP-093)', () => {
  let app

  beforeEach(() => {
    app = express()
    app.use('/docs', createDocsRouter())
  })

  it('serves self-contained HTML on GET /docs with correct CSP and no external scripts', async () => {
    const res = await request(app).get('/docs')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'")

    // Must not contain external script or stylesheet tags
    expect(res.text).not.toMatch(/<script/i)
    expect(res.text).not.toMatch(/<link[^>]+rel=["']stylesheet["']/i)
    expect(res.text).not.toMatch(/https?:\/\//) // No external URLs
    expect(res.text).toContain('<!doctype html>')
    expect(res.text).toContain('REST Endpoints')
    expect(res.text).toContain('GraphQL Schema')
  })

  it('serves versioned JSON API reference when requested via format=json or Accept header', async () => {
    const resQuery = await request(app).get('/docs?format=json')
    expect(resQuery.status).toBe(200)
    expect(resQuery.body).toHaveProperty('version')
    expect(resQuery.body).toHaveProperty('routes')
    expect(resQuery.body).toHaveProperty('graphql')
    expect(resQuery.body).toHaveProperty('tiers')

    const resHeader = await request(app).get('/docs').set('Accept', 'application/json')
    expect(resHeader.status).toBe(200)
    expect(resHeader.body.routes.length).toBeGreaterThan(0)
    expect(resHeader.body.graphql.length).toBeGreaterThan(0)

    const resDirect = await request(app).get('/docs/json')
    expect(resDirect.status).toBe(200)
    expect(resDirect.body.version).toBe(resHeader.body.version)
  })

  it('labels routes with ADR-020 priority tiers (P0, P1, P2, P3)', async () => {
    const ref = buildApiReference()
    expect(ref.tiers).toEqual(ADR020_TIERS)

    const p0Routes = ref.routes.filter((r) => r.tier === 'P0')
    const p1Routes = ref.routes.filter((r) => r.tier === 'P1')
    const p2Routes = ref.routes.filter((r) => r.tier === 'P2')

    // POST /api/dispatch must be P0
    const dispatchCreate = ref.routes.find((r) => r.path === '/api/dispatch' && r.method === 'POST')
    expect(dispatchCreate).toBeDefined()
    expect(dispatchCreate.tier).toBe('P0')

    expect(p0Routes.length).toBeGreaterThan(0)
    expect(p1Routes.length).toBeGreaterThan(0)
    expect(p2Routes.length).toBeGreaterThan(0)

    // Classify helper test
    expect(classifyRouteTier('/api/dispatch', 'POST').tier).toBe('P0')
    expect(classifyRouteTier('/api/dispatch', 'GET').tier).toBe('P1')
    expect(classifyRouteTier('/api/events/ice-metrics', 'POST').tier).toBe('P3')
    expect(classifyRouteTier('/docs', 'GET').tier).toBe('P2')
  })

  it('enforces HP-093 contract drift guard and verifies swagger/schema sync', async () => {
    const status = verifyContractDrift()
    expect(status.synced).toBe(true)
    expect(status.routeCount).toBeGreaterThan(0)
    expect(status.graphqlCount).toBeGreaterThan(0)
    expect(status.walletLeakDetected).toBe(false)

    const res = await request(app).get('/docs/drift-status')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, driftGuard: 'HP-093', synced: true })
  })

  it('contains zero raw wallet addresses (Stellar/EVM) in rendered output', async () => {
    const resHtml = await request(app).get('/docs')
    expect(containsWalletAddress(resHtml.text)).toBe(false)

    const resJson = await request(app).get('/docs/json')
    expect(containsWalletAddress(JSON.stringify(resJson.body))).toBe(false)

    // Verify regexes catch test addresses
    const stellarPk = 'GBRPYHIL2CI3FNQ4AFAGFKCGOMTUJQK4G3PWBRO3YAORZBX5STCHWD27'
    const evmAddr = '0x71C841032685d0e23823044a5E49575441662923'
    expect(containsWalletAddress(stellarPk)).toBe(true)
    expect(containsWalletAddress(evmAddr)).toBe(true)
    expect(containsWalletAddress(redactWalletAddresses(stellarPk))).toBe(false)
    expect(containsWalletAddress(redactWalletAddresses(evmAddr))).toBe(false)
  })
})
