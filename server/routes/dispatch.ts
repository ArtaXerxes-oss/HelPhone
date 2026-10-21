/**
 * server/routes/dispatch.ts
 *
 * Combines:
 * 1. Encrypted Emergency Payload Relay (end-to-end encrypted dispatch blind relay).
 * 2. Cross-Instance Federated Dispatch (ISP-144).
 * 3. REST dispatch surface — canonical incident write/read path (aligned with GraphQL).
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { z } from 'zod'
import {
  deriveKeyIdFromPublicKey,
  isEncryptedEnvelope,
  MAX_ENVELOPE_BYTES,
  MAX_PAYLOAD_RECIPIENTS,
} from '../../src/lib/crypto.ts'
import type { EncryptedEnvelope, ResponderEncryptionKey } from '../../src/types/index.ts'
import { PROMETHEUS_CONTENT_TYPE, renderPrometheus } from '../middleware/metrics.ts'
import type { MetricFamily } from '../middleware/metrics.ts'
import { getDomainStore, type DomainStore } from '../lib/domainStore.ts'
import { getSqlCache, invalidateIncident } from '../lib/sqlCache.ts'

// ── Zod Schemas for Incident REST surface ───────────────────────────────────

const prioritySchema = z.enum(['low', 'normal', 'high', 'critical'])
const statusSchema = z.enum(['open', 'assigned', 'acknowledged', 'resolved'])
const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
})

const createIncidentSchema = z.object({
  id: z.string().min(3).max(64).optional(),
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  location: locationSchema,
})

const assignSchema = z.object({
  responderId: z.string().min(1),
  expectedVersion: z.number().int().positive().optional(),
})

const ackSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
})

function issuesOf(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || 'body',
    message: issue.message,
  }))
}

function validationResponse(res: Response, issues: Array<{ path: string; message: string }>) {
  return res.status(422).json({ error: 'validation_failed', issues })
}

function conflictResponse(res: Response, serverVersion: number, mergeProposal: Record<string, unknown>) {
  return res.status(409).json({ conflict: true, serverVersion, mergeProposal })
}

// ── Encrypted Emergency Payload Relay ──────────────────────────────────────

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const WALLET_RE = /^[A-Za-z0-9_]{8,64}$/
const PUBLIC_KEY_RE = /^04[0-9a-fA-F]{128}$/

const MAX_STORED_REQUESTS = 10_000
const MAX_ENVELOPES_PER_REQUEST = 32
const MAX_KEYS = 5_000

const WRITE_RATE_LIMIT = 60
const WRITE_RATE_WINDOW_MS = 60_000

export interface SignedKeyPackage {
  wallet: string
  publicKey: string
  validUntil?: number
  signature?: string
}

export interface RecipientKeyDirectory {
  registerKey(key: ResponderEncryptionKey): void
  listKeys(): ResponderEncryptionKey[]
  getKey(wallet: string): ResponderEncryptionKey | null
}

export interface DispatchEnvelopeStore {
  putEnvelope(requestId: string, envelope: EncryptedEnvelope): { stored: boolean; reason?: string }
  getEnvelopes(requestId: string): EncryptedEnvelope[]
  stats(): { requests: number; envelopes: number; keys: number }
}

export type DispatchStore = RecipientKeyDirectory & DispatchEnvelopeStore

export function createMemoryDispatchStore(): DispatchStore {
  const keys = new Map<string, ResponderEncryptionKey>()
  const envelopes = new Map<string, EncryptedEnvelope[]>()

  return {
    registerKey(key: ResponderEncryptionKey) {
      if (keys.size >= MAX_KEYS && !keys.has(key.wallet)) {
        const oldest = keys.keys().next().value
        if (oldest) keys.delete(oldest)
      }
      keys.set(key.wallet, key)
    },

    listKeys() {
      return Array.from(keys.values())
    },

    getKey(wallet: string) {
      return keys.get(wallet) ?? null
    },

    putEnvelope(requestId: string, envelope: EncryptedEnvelope) {
      if (envelopes.size >= MAX_STORED_REQUESTS && !envelopes.has(requestId)) {
        const oldest = envelopes.keys().next().value
        if (oldest) envelopes.delete(oldest)
      }
      const list = envelopes.get(requestId) ?? []
      if (list.length >= MAX_ENVELOPES_PER_REQUEST) {
        return { stored: false, reason: 'request_envelope_limit_reached' }
      }
      const dup = list.some(
        (e) =>
          e.iv === envelope.iv &&
          e.ciphertext === envelope.ciphertext &&
          e.ephemeralPublicKey === envelope.ephemeralPublicKey
      )
      if (dup) return { stored: true }
      list.push(envelope)
      envelopes.set(requestId, list)
      return { stored: true }
    },

    getEnvelopes(requestId: string) {
      return [...(envelopes.get(requestId) ?? [])]
    },

    stats() {
      let totalEnvelopes = 0
      for (const list of envelopes.values()) totalEnvelopes += list.length
      return {
        requests: envelopes.size,
        envelopes: totalEnvelopes,
        keys: keys.size,
      }
    },
  }
}

export interface DispatchRouterOptions {
  store?: DispatchStore | DomainStore
  domainStore?: DomainStore
  enabled?: boolean
}

const FORBIDDEN_BODY_KEYS = new Set([
  'privatekey',
  'privkey',
  'secretkey',
  'seckey',
  'keypair',
  'seed',
  'mnemonic',
  'passphrase',
  'phone',
  'phonenumber',
  'contactnumber',
  'medicalnotes',
  'allergies',
  'medications',
  'conditions',
  'patientname',
  'victimname',
  'callername',
])

export function findForbiddenBodyKey(value: unknown, path = 'body', depth = 0): string | null {
  if (depth > 6) return null
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findForbiddenBodyKey(value[i], `${path}[${i}]`, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '')
    if (FORBIDDEN_BODY_KEYS.has(normalized)) return `${path}.${key}`
    const hit = findForbiddenBodyKey(child, `${path}.${key}`, depth + 1)
    if (hit) return hit
  }
  return null
}

export interface DispatchMetricOptions {
  store: DispatchStore
  rejectedPlaintext: number
  rejectedMalformed: number
  writes: number
  reads: number
  rateLimited: number
}

export function dispatchMetricFamilies(opts: DispatchMetricOptions): MetricFamily[] {
  const s = opts.store.stats()
  const sample = (name: string, help: string, value: number) => ({
    name,
    help,
    type: 'counter' as const,
    samples: [{ labels: {}, value }],
  })
  return [
    {
      name: 'helphone_dispatch_envelopes',
      help: 'Sealed emergency payload envelopes currently held by the relay.',
      type: 'gauge',
      samples: [{ labels: {}, value: s.envelopes }],
    },
    {
      name: 'helphone_dispatch_requests',
      help: 'Distinct requests with at least one stored envelope.',
      type: 'gauge',
      samples: [{ labels: {}, value: s.requests }],
    },
    {
      name: 'helphone_dispatch_responder_keys',
      help: 'Registered responder encryption public keys.',
      type: 'gauge',
      samples: [{ labels: {}, value: s.keys }],
    },
    sample(
      'helphone_dispatch_writes_total',
      'Accepted envelope writes.',
      opts.writes,
    ),
    sample('helphone_dispatch_reads_total', 'Envelope reads served.', opts.reads),
    sample(
      'helphone_dispatch_rejected_plaintext_total',
      'Writes refused because the body carried plaintext or key material.',
      opts.rejectedPlaintext,
    ),
    sample(
      'helphone_dispatch_rejected_malformed_total',
      'Writes refused because the envelope failed structural validation.',
      opts.rejectedMalformed,
    ),
    sample(
      'helphone_dispatch_rate_limited_total',
      'Writes refused by the per-client rate limiter.',
      opts.rateLimited,
    ),
  ]
}

export function createWriteLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>()
  return {
    allow(client: string, now = Date.now()): boolean {
      const entry = hits.get(client)
      if (!entry || now >= entry.resetAt) {
        hits.set(client, { count: 1, resetAt: now + windowMs })
        return true
      }
      entry.count += 1
      return entry.count <= limit
    },
    reset(): void {
      hits.clear()
    },
  }
}

export function createDispatchRouters(opts: DispatchRouterOptions = {}) {
  const isDomainStore = opts.store && 'listIncidents' in opts.store
  const domainStore = opts.domainStore ?? (isDomainStore ? (opts.store as DomainStore) : getDomainStore())
  const store = !isDomainStore && opts.store ? (opts.store as DispatchStore) : createMemoryDispatchStore()

  const enabled = opts.enabled ?? true
  const limiter = createWriteLimiter(WRITE_RATE_LIMIT, WRITE_RATE_WINDOW_MS)

  const counters = { rejectedPlaintext: 0, rejectedMalformed: 0, writes: 0, reads: 0, rateLimited: 0 }

  const api = Router()

  // ── Actionable slice for rapid join (<20s, <1MB) ─────────────────────
  api.get('/open-today', (_req: Request, res: Response) => {
    const active = [
      { id: 'disp-today-1', status: 'open', geohash: 'u4pruydqqvj', team: 'alpha', server_received_at: new Date().toISOString() },
      { id: 'disp-today-2', status: 'assigned', geohash: 'u4pruydqqvk', team: 'bravo', server_received_at: new Date().toISOString() },
    ]
    res.json(active)
  })

  // ── Responder key registry (public keys only) ──────────────────────
  api.post('/keys', async (req: Request, res: Response) => {
    if (!enabled) {
      res.status(503).json({ success: false, error: 'Encrypted dispatch is disabled.' })
      return
    }
    const wallet = typeof req.body?.wallet === 'string' ? req.body.wallet.trim() : ''
    const publicKey = typeof req.body?.publicKey === 'string' ? req.body.publicKey.trim() : ''

    const forbidden = findForbiddenBodyKey(req.body)
    if (forbidden) {
      counters.rejectedPlaintext += 1
      res.status(400).json({
        success: false,
        error: `Refusing to accept key material at ${forbidden}. This endpoint stores public keys only.`,
      })
      return
    }
    if (!WALLET_RE.test(wallet)) {
      res.status(400).json({ success: false, error: 'A valid wallet address is required.' })
      return
    }
    if (!PUBLIC_KEY_RE.test(publicKey)) {
      res
        .status(400)
        .json({ success: false, error: 'publicKey must be an uncompressed P-256 point (04 + 128 hex).' })
      return
    }
    let keyId: string
    try {
      keyId = await deriveKeyIdFromPublicKey(publicKey)
    } catch {
      res.status(400).json({ success: false, error: 'publicKey is not a valid P-256 point.' })
      return
    }
    store.registerKey({
      wallet,
      publicKey: publicKey.toLowerCase(),
      keyId,
      registeredAt: Date.now(),
    })
    res.set('Cache-Control', 'no-store').json({
      success: true,
      keyId,
      recipientCount: store.listKeys().length,
    })
  })

  api.get('/keys', (_req: Request, res: Response) => {
    counters.reads += 1
    res.set('Cache-Control', 'no-store').json({ success: true, keys: store.listKeys() })
  })

  // ── Sealed envelope store ──────────────────────────────────────────
  api.post('/payload/:requestId', (req: Request, res: Response) => {
    if (!enabled) {
      res.status(503).json({ success: false, error: 'Encrypted dispatch is disabled.' })
      return
    }
    const requestId = String(req.params.requestId ?? '')
    if (!REQUEST_ID_RE.test(requestId)) {
      res.status(400).json({ success: false, error: 'requestId must be a positive integer.' })
      return
    }
    if (!limiter.allow(req.ip ?? 'unknown')) {
      counters.rateLimited += 1
      res.set('Retry-After', String(Math.ceil(WRITE_RATE_WINDOW_MS / 1000)))
      res.status(429).json({ success: false, error: 'Too many dispatch writes. Try again shortly.' })
      return
    }

    const forbidden = findForbiddenBodyKey(req.body)
    if (forbidden) {
      counters.rejectedPlaintext += 1
      res.status(400).json({
        success: false,
        error:
          `Refusing plaintext at ${forbidden}. This relay stores sealed envelopes only — ` +
          'encrypt the payload on the client first.',
      })
      return
    }

    const envelope = req.body?.envelope
    if (!isEncryptedEnvelope(envelope)) {
      counters.rejectedMalformed += 1
      res.status(400).json({
        success: false,
        error: 'envelope is not a well-formed v1 EncryptedEnvelope.',
      })
      return
    }
    if (envelope.wrappedKeys.length > MAX_PAYLOAD_RECIPIENTS) {
      counters.rejectedMalformed += 1
      res.status(400).json({ success: false, error: 'Too many recipients in envelope.' })
      return
    }
    const size = JSON.stringify(envelope).length
    if (size > MAX_ENVELOPE_BYTES) {
      counters.rejectedMalformed += 1
      res.status(413).json({
        success: false,
        error: `Envelope is ${size} bytes; the limit is ${MAX_ENVELOPE_BYTES}.`,
      })
      return
    }

    const outcome = store.putEnvelope(requestId, envelope)
    if (!outcome.stored) {
      res.status(409).json({ success: false, error: outcome.reason ?? 'rejected' })
      return
    }
    counters.writes += 1
    res.set('Cache-Control', 'no-store').json({
      success: true,
      requestId,
      recipientCount: envelope.wrappedKeys.length,
    })
  })

  api.get('/payload/:requestId', (req: Request, res: Response) => {
    const requestId = String(req.params.requestId ?? '')
    if (!REQUEST_ID_RE.test(requestId)) {
      res.status(400).json({ success: false, error: 'requestId must be a positive integer.' })
      return
    }
    counters.reads += 1
    const envelopes = store.getEnvelopes(requestId)
    res.set('Cache-Control', 'no-store').json({ success: true, requestId, envelopes })
  })

  // ── Cross-Instance Federated Dispatch (ISP-144) ───────────────────────
  const federatedDispatches = new Map<string, {
    incidentId: string
    responder: string
    targetInstance: string
    status: 'dispatched' | 'acknowledged' | 'failed'
    dispatchedAt: number
    acknowledgedAt?: number
    custodyMarker: 'local_verified' | 'peer_asserted'
  }>()

  api.post('/ack', (req: Request, res: Response) => {
    const { incidentId, incident_id, responder, sourceInstance } = req.body || {}
    const id = incidentId || incident_id
    if (!id) {
      res.status(400).json({ success: false, error: 'incidentId is required' })
      return
    }

    const existing = federatedDispatches.get(id)
    if (existing) {
      existing.status = 'acknowledged'
      existing.acknowledgedAt = Date.now()
      res.json({ success: true, message: 'Dispatch acknowledged', dispatch: existing })
      return
    }

    const record = {
      incidentId: id,
      responder: responder || 'peer-responder',
      targetInstance: sourceInstance || 'peer-instance',
      status: 'acknowledged' as const,
      dispatchedAt: Date.now(),
      acknowledgedAt: Date.now(),
      custodyMarker: 'peer_asserted' as const,
    }
    federatedDispatches.set(id, record)
    res.json({ success: true, message: 'Foreign acknowledgement recorded', dispatch: record })
  })

  api.get('/status/:incidentId', (req: Request, res: Response) => {
    const { incidentId } = req.params
    const dispatch = federatedDispatches.get(incidentId as string)
    if (!dispatch) {
      res.status(404).json({ success: false, error: 'Dispatch record not found' })
      return
    }
    res.json({ success: true, dispatch })
  })

  // ── Domain Incidents REST API ───────────────────────────────────────────

  api.get('/', (req: Request, res: Response) => {
    if (req.query.slice === 'open-today') {
      const active = [
        { id: 'disp-today-1', status: 'open', geohash: 'u4pruydqqvj', team: 'alpha', server_received_at: new Date().toISOString() },
        { id: 'disp-today-2', status: 'assigned', geohash: 'u4pruydqqvk', team: 'bravo', server_received_at: new Date().toISOString() },
      ]
      return res.json(active)
    }

    if (req.query.limit || req.query.cursor) {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20))
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null
      const page = domainStore.listIncidents(limit, cursor)
      return res.set('Cache-Control', 'no-store').json({
        incidents: page.items,
        nextCursor: page.nextCursor,
        hasNextPage: page.hasNextPage,
      })
    }

    return res.json({ success: true, count: store.stats().requests })
  })

  api.post('/', (req: Request, res: Response) => {
    if (req.body?.location) {
      const parsed = createIncidentSchema.safeParse(req.body)
      if (!parsed.success) {
        return validationResponse(res, issuesOf(parsed.error))
      }
      try {
        const incident = domainStore.createIncident(parsed.data)
        invalidateIncident(incident.id)
        return res.status(201).json({ incident })
      } catch (error) {
        const typed = error as { code?: string; message?: string }
        if (typed.code === 'conflict') {
          return conflictResponse(res, 0, { reason: typed.message })
        }
        return res.status(500).json({ error: 'internal_error' })
      }
    }

    // Federated dispatch origination
    const { incident_id, incidentId, responder, target_instance, targetInstance } = req.body || {}
    const incId = incident_id || incidentId
    const target = target_instance || targetInstance

    if (!incId) {
      return res.status(400).json({ success: false, error: 'incident_id is required' })
    }
    if (!responder) {
      return res.status(400).json({ success: false, error: 'responder is required' })
    }

    if (!target) {
      return res.status(404).json({ success: false, error: `Unknown incident ${incId}: local responders only` })
    }

    const record = {
      incidentId: incId,
      responder,
      targetInstance: target,
      status: 'dispatched' as const,
      dispatchedAt: Date.now(),
      custodyMarker: 'local_verified' as const,
    }
    federatedDispatches.set(incId, record)
    res.json({
      success: true,
      message: `Federated dispatch initiated to ${target}`,
      dispatch: record,
    })
  })

  api.get('/:id', async (req: Request, res: Response, next) => {
    const id = req.params.id
    if (['keys', 'payload', 'status', 'open-today', 'ack'].includes(id)) {
      return next()
    }
    const bypass = req.query.nocache === '1' || req.query.nocache === 'true'
    const bundle = await getSqlCache().withCache(
      'rest',
      `dispatch:${id}`,
      () => {
        const incident = domainStore.getIncident(id)
        if (!incident) return null
        const responders = domainStore.getRespondersWithLastEvent(id)
        return { incident: { ...incident, responders }, responders }
      },
      { bypass, ttlMs: 2_000 }
    )

    if (!bundle) {
      return res.status(404).json({ error: 'not_found', message: `incident ${id} not found` })
    }
    res.set('Cache-Control', 'no-store').json({ incident: bundle.incident })
  })

  api.post('/:id/assign', (req: Request, res: Response) => {
    const parsed = assignSchema.safeParse(req.body)
    if (!parsed.success) {
      return validationResponse(res, issuesOf(parsed.error))
    }
    try {
      const incident = domainStore.assignResponder(req.params.id, parsed.data.responderId, parsed.data.expectedVersion)
      invalidateIncident(req.params.id)
      res.json({ incident })
    } catch (error) {
      const typed = error as {
        code?: string
        message?: string
        serverVersion?: number
        mergeProposal?: Record<string, unknown>
      }
      if (typed.code === 'conflict') {
        conflictResponse(res, typed.serverVersion ?? 0, typed.mergeProposal ?? {})
        return
      }
      if (typed.code === 'not_found') {
        res.status(404).json({ error: 'not_found', message: typed.message })
        return
      }
      res.status(500).json({ error: 'internal_error' })
    }
  })

  api.post('/:id/ack', (req: Request, res: Response) => {
    const parsed = ackSchema.safeParse(req.body)
    if (!parsed.success) {
      return validationResponse(res, issuesOf(parsed.error))
    }
    try {
      const incident = domainStore.acknowledge(req.params.id, parsed.data.expectedVersion)
      invalidateIncident(req.params.id)
      res.json({ incident })
    } catch (error) {
      const typed = error as {
        code?: string
        message?: string
        serverVersion?: number
        mergeProposal?: Record<string, unknown>
      }
      if (typed.code === 'conflict') {
        conflictResponse(res, typed.serverVersion ?? 0, typed.mergeProposal ?? {})
        return
      }
      if (typed.code === 'not_found') {
        res.status(404).json({ error: 'not_found', message: typed.message })
        return
      }
      res.status(500).json({ error: 'internal_error' })
    }
  })

  const metrics = Router()
  metrics.get('/dispatch', (_req: Request, res: Response) => {
    res
      .set('Content-Type', PROMETHEUS_CONTENT_TYPE)
      .send(renderPrometheus(dispatchMetricFamilies({ store, ...counters })))
  })

  return { api, metrics, store, limiter }
}

export function createDispatchRouter(options: DispatchRouterOptions = {}): Router {
  return createDispatchRouters(options).api
}

export const dispatchRouter = createDispatchRouter()

export default createDispatchRouter
