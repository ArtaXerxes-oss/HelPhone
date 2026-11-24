import { Router, raw } from 'express'
import { getDomainStore, type DomainStore } from '../lib/domainStore.ts'
import { TELEMETRY_BUDGETS, verifyIngest } from '../telemetry.js'

/**
 * Event log + WebRTC ICE helpers.
 *
 * Pagination contract (shared with GraphQL EventConnection):
 *   REST:    { events, nextCursor, hasNextPage }
 *   GraphQL: { edges { node cursor }, pageInfo { hasNextPage endCursor } }
 * Both cursors are opaque event cursors from the same store query.
 */
export function createEventsRouter(options: { store?: DomainStore } = {}): Router {
  const store = options.store ?? getDomainStore()
  const router = Router()

  router.get('/', (req, res) => {
    const incidentId = typeof req.query.incidentId === 'string' ? req.query.incidentId : ''
    if (!incidentId) {
      res.status(422).json({ error: 'validation_failed', issues: [{ path: 'incidentId', message: 'required' }] })
      return
    }
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 20))
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null
    const page = store.getEventsByIncident(incidentId, { limit, cursor })
    res.set('Cache-Control', 'no-store').json({
      events: page.items,
      nextCursor: page.nextCursor,
      hasNextPage: page.hasNextPage,
    })
  })

  router.get('/ice-config', (_req, res) => {
    const urls = (process.env.TURN_URLS || '').split(',').map((v) => v.trim()).filter(Boolean)
    res.set('Cache-Control', 'no-store').json({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }, ...(urls.length ? [{ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }] : [])],
      fallback: { transport: 'websocket', endpoint: '/api/events/frame-stream' },
    })
  })

  router.get('/subscription-transport', (_req, res) => {
    res.json({ transport: 'websocket', endpoint: '/events/ws', resume: 'sequence', http2Push: false })
  })

  router.post('/ice-metrics', (req, res) => {
    const { gatheringMs, success, hasRelay } = req.body || {}
    if (!Number.isFinite(gatheringMs) || typeof success !== 'boolean' || typeof hasRelay !== 'boolean') { res.status(400).json({ error: 'invalid ICE metric' }); return }
    console.info('[ice-metric]', { gatheringMs, success, hasRelay })
    res.status(202).json({ accepted: true })
  })

  // Low-rate JSON discovery; high-rate live positions are binary HPTL frames.
  router.get('/frames/config', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      transport: 'websocket',
      endpoint: '/api/events/frame-stream',
      binaryType: 'arraybuffer',
      fileIdentifier: 'HPTL',
      ...TELEMETRY_BUDGETS,
    })
  })

  // HTTP fallback ingest for clients without WebSocket. Verification never
  // throws: malformed frames get 400 and never reach the main path.
  router.post(
    '/frames',
    raw({ type: () => true, limit: TELEMETRY_BUDGETS.maxFrameBytes }),
    (req, res) => {
      const body = req.body instanceof Uint8Array ? req.body : Buffer.from(req.body || '')
      const result = verifyIngest(body)
      if (!result.ok) {
        res.status(400).json({ accepted: false, error: result.error })
        return
      }
      res.status(202).json({ accepted: true, objectCount: result.objectCount, byteLength: result.byteLength })
    },
  )

  return router
}

export const eventsRouter = createEventsRouter()
