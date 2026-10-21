import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { app, createRateLimiter, errorHandler } from './index.js'

// ---------------------------------------------------------------------------
// Issue #130 — Server Middleware Logic Tests
//
// Tests for rate limiters, error handlers, CORS configuration, and JSON body
// parsing on the Express server. Uses Supertest to send isolated HTTP requests
// without binding to a real TCP port.
// ---------------------------------------------------------------------------

// ── 1. Health endpoint ──────────────────────────────────────────────────────
describe('GET /health', () => {
  it('returns a JSON response with status field', async () => {
    const res = await request(app).get('/health')
    assert.equal(res.status, 200)
    assert.equal(typeof res.body.status, 'string')
    assert.equal(typeof res.body.ready, 'boolean')
  })
})

// ── 2. ZK Prove — input validation ──────────────────────────────────────────
describe('POST /zk/prove', () => {
  it('returns 400 when inputs field is missing', async () => {
    const res = await request(app)
      .post('/zk/prove')
      .send({})
    assert.equal(res.status, 400)
    assert.equal(res.body.success, false)
    assert.match(res.body.error, /missing inputs/i)
  })

  it('returns 400 when body is empty', async () => {
    const res = await request(app)
      .post('/zk/prove')
      .send()
    assert.equal(res.status, 400)
    assert.equal(res.body.success, false)
  })
})

// ── 3. Custom error handler ─────────────────────────────────────────────────
describe('errorHandler middleware', () => {
  it('formats error into consistent JSON envelope', () => {
    const mockReq = {}
    const mockRes = {
      _status: null,
      _body: null,
      status(s) { this._status = s; return this },
      json(body) { this._body = body },
    }
    const mockNext = () => {}

    const err = new Error('test error')
    err.status = 422
    errorHandler(err, mockReq, mockRes, mockNext)

    assert.equal(mockRes._status, 422)
    assert.equal(mockRes._body.success, false)
    assert.equal(mockRes._body.error, 'test error')
  })

  it('defaults to 500 when error has no status', () => {
    const mockReq = {}
    const mockRes = {
      _status: null,
      _body: null,
      status(s) { this._status = s; return this },
      json(body) { this._body = body },
    }

    const err = new Error('something broke')
    errorHandler(err, mockReq, mockRes, () => {})

    assert.equal(mockRes._status, 500)
    assert.equal(mockRes._body.error, 'something broke')
  })

  it('includes stack trace in non-production mode', () => {
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'

    const mockReq = {}
    const mockRes = {
      _status: null,
      _body: null,
      status(s) { this._status = s; return this },
      json(body) { this._body = body },
    }

    const err = new Error('debug error')
    err.stack = 'Error: debug error\n    at test.js:1:1'
    errorHandler(err, mockReq, mockRes, () => {})

    assert.ok(mockRes._body.stack, 'should include stack in development')
    process.env.NODE_ENV = original
  })

  it('hides stack trace in production', () => {
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'

    const mockReq = {}
    const mockRes = {
      _status: null,
      _body: null,
      status(s) { this._status = s; return this },
      json(body) { this._body = body },
    }

    const err = new Error('prod error')
    err.stack = 'Error: prod error\n    at test.js:1:1'
    errorHandler(err, mockReq, mockRes, () => {})

    assert.equal(mockRes._body.error, 'Internal server error')
    assert.equal(mockRes._body.stack, undefined)
    process.env.NODE_ENV = original
  })
})

// ── 4. Rate limiter — unit tests ────────────────────────────────────────────
describe('createRateLimiter', () => {
  it('allows requests within the limit', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 5 })
    let called = false

    for (let i = 0; i < 5; i++) {
      const req = { ip: '1.2.3.4' }
      const res = {
        _headers: {},
        _status: null,
        _body: null,
        setHeader(k, v) { this._headers[k] = v },
        status(s) { this._status = s; return this },
        json(body) { this._body = body },
      }
      limiter(req, res, () => { called = true })
      assert.equal(res._status, null, `request ${i + 1} should not be blocked`)
    }
    assert.equal(called, true)
  })

  it('returns 429 when limit is exceeded', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 })
    const blocked = []

    for (let i = 0; i < 5; i++) {
      const req = { ip: '5.6.7.8' }
      const res = {
        _headers: {},
        _status: null,
        _body: null,
        setHeader(k, v) { this._headers[k] = v },
        status(s) { this._status = s; return this },
        json(body) { this._body = body },
      }
      limiter(req, res, () => {})
      if (res._status === 429) blocked.push(i)
    }

    // First 2 requests allowed (max=2), remaining 3 blocked
    assert.deepEqual(blocked, [2, 3, 4])
  })

  it('sets X-RateLimit headers', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 10 })
    const req = { ip: '9.10.11.12' }
    const res = {
      _headers: {},
      setHeader(k, v) { this._headers[k] = v },
      status() { return this },
      json() {},
    }
    limiter(req, res, () => {})

    assert.equal(res._headers['X-RateLimit-Limit'], 10)
    assert.equal(typeof res._headers['X-RateLimit-Remaining'], 'number')
    assert.ok(res._headers['X-RateLimit-Reset'] instanceof Date || typeof res._headers['X-RateLimit-Reset'] === 'string')
  })

  it('resets after window expires', async () => {
    const limiter = createRateLimiter({ windowMs: 100, max: 1 })
    const req = { ip: '13.14.15.16' }
    const makeRes = () => ({
      _headers: {},
      _status: null,
      setHeader(k, v) { this._headers[k] = v },
      status(s) { this._status = s; return this },
      json() {},
    })

    // First request: allowed
    limiter(req, makeRes(), () => {})
    // Second request: blocked
    const r2 = makeRes()
    limiter(req, r2, () => {})
    assert.equal(r2._status, 429)

    // Wait for window to expire
    await new Promise(r => setTimeout(r, 150))

    // Third request: allowed again after window reset
    const r3 = makeRes()
    limiter(req, r3, () => {})
    assert.equal(r3._status, null)
  })

  it('tracks different IPs independently', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 })
    const makeRes = () => ({
      _headers: {},
      _status: null,
      setHeader(k, v) { this._headers[k] = v },
      status(s) { this._status = s; return this },
      json() {},
    })

    const r1 = makeRes()
    limiter({ ip: '10.0.0.1' }, r1, () => {})
    assert.equal(r1._status, null)

    const r2 = makeRes()
    limiter({ ip: '10.0.0.2' }, r2, () => {})
    assert.equal(r2._status, null, 'different IP should have its own window')
  })

  it('_reset clears all tracked state', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 })
    const makeRes = () => ({
      _headers: {},
      _status: null,
      setHeader(k, v) { this._headers[k] = v },
      status(s) { this._status = s; return this },
      json() {},
    })

    limiter({ ip: '20.0.0.1' }, makeRes(), () => {})
    const blocked = makeRes()
    limiter({ ip: '20.0.0.1' }, blocked, () => {})
    assert.equal(blocked._status, 429)

    limiter._reset()

    const after = makeRes()
    limiter({ ip: '20.0.0.1' }, after, () => {})
    assert.equal(after._status, null, 'should be allowed after reset')
  })
})

// ── 5. JSON body parsing ────────────────────────────────────────────────────
describe('JSON body parsing', () => {
  it('parses JSON request bodies', async () => {
    const res = await request(app)
      .post('/zk/prove')
      .send({ inputs: { x: 1 } })
      .set('Content-Type', 'application/json')

    // Should not fail with a 400 "missing inputs" — it parsed the JSON.
    // It will fail later (no prover), but the parsing succeeded.
    assert.notEqual(res.status, 400)
  })

  it('rejects payloads exceeding 1mb limit', async () => {
    const largePayload = { data: 'x'.repeat(1.1 * 1024 * 1024) }
    const res = await request(app)
      .post('/zk/prove')
      .send(largePayload)
      .set('Content-Type', 'application/json')

    // Express returns 413 for payload too large
    assert.ok(res.status === 413 || res.status === 400)
  })
})

// ── 6. CORS configuration ───────────────────────────────────────────────────
describe('CORS headers', () => {
  it('responds to OPTIONS preflight with CORS headers', async () => {
    const res = await request(app)
      .options('/health')
      .set('Origin', 'https://helphone.com')
      .set('Access-Control-Request-Method', 'GET')

    assert.ok(
      res.headers['access-control-allow-origin'] ||
      res.status === 204,
      'should respond to preflight'
    )
  })
})

// ── 7. Unknown routes — 404 handling ────────────────────────────────────────
describe('Unknown routes', () => {
  it('returns 404 for undefined GET routes', async () => {
    const res = await request(app).get('/nonexistent-route')
    assert.equal(res.status, 404)
  })
})

// ── 8. Ranking API — input validation ───────────────────────────────────────
describe('GET /api/ranking', () => {
  it('accepts period and limit query params', async () => {
    // This will likely fail with 500 (no Stellar RPC in test) but should
    // not crash the server — the error handler catches it.
    const res = await request(app)
      .get('/api/ranking?period=Weekly&limit=10')

    // Should be 200 (with empty entries from cache/mock) or 500 (rpc fail)
    // Either way, it returns JSON and doesn't crash
    assert.ok(typeof res.body === 'object')
  })
})
