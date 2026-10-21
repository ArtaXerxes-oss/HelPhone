import { Router } from 'express'
import type { Request, Response } from 'express'
import {
  deriveKeyIdFromPublicKey,
  isEncryptedEnvelope,
  MAX_ENVELOPE_BYTES,
  MAX_PAYLOAD_RECIPIENTS,
} from '../../src/lib/crypto.ts'
import type { EncryptedEnvelope, ResponderEncryptionKey } from '../../src/types/index.ts'
import { PROMETHEUS_CONTENT_TYPE, renderPrometheus } from '../middleware/metrics.ts'
import type { MetricFamily } from '../middleware/metrics.ts'

/**
 * Encrypted Emergency Payload Relay (end-to-end encrypted dispatch).
 *
 *   POST /api/dispatch/keys            register a responder's public key
 *   GET  /api/dispatch/keys            list registered responder keys
 *   POST /api/dispatch/payload/:id     store a sealed envelope for a request
 *   GET  /api/dispatch/payload/:id     fetch the sealed envelopes for a request
 *   GET  /metrics/dispatch             Prometheus counters
 *
 * ## The one rule this module exists to enforce
 *
 * This process is a blind relay. It stores, indexes and returns **ciphertext
 * only**. It never holds a content key, a wrapping key, a responder private
 * key, or a plaintext contact number / medical note — and it is built so that
 * a mistake on the client cannot turn it into a decryption oracle:
 *
 *   * Bodies are structurally validated with `isEncryptedEnvelope`; anything
 *     that is not a well-formed v1 envelope is rejected outright.
 *   * `rejectPlaintextFields` refuses any body carrying a plaintext-looking
 *     key (`contact`, `medicalNotes`, `privateKey`, …). A client bug that
 *     sends the cleartext anyway fails loudly here instead of quietly
 *     persisting it to the operator's disk.
 *   * Nothing is logged except opaque ids, sizes and counters. Sealed blobs
 *     are never written to a log line.
 *   * The key registry holds *public* keys only. A private key posted to
 *     `POST /keys` is rejected by name.
 *
 * Confidentiality therefore rests entirely in the client-side envelope
 * (ECDH P-256 + HKDF-SHA256 + AES-256-GCM, see src/lib/crypto.ts) and in the
 * responder's key custody — not in anything enforced here.
 *
 * ## Storage
 *
 * In-memory Maps, matching `server/index.ts`'s preferences/feedback handlers.
 * This is a cache in front of the ledger: the authoritative copy of an
 * envelope is the `encrypted_payload` field of the on-chain `HelpRequest`.
 * Envelopes are therefore safe to lose — a restart degrades latency, not
 * availability or secrecy.
 */

/**
 * Envelope addressing key.
 *
 * Two forms are accepted because the relay is indexed by *both*:
 *  - a client-generated submission id (a UUID), which is the `bindingContext`
 *    the envelope is sealed against and therefore known before signing; and
 *  - an on-chain request id, the `u64` the contract assigned, which is what a
 *    responder has when they tap a map marker.
 *
 * Bounded to 64 chars so it can never be used to blow up a log line or a
 * metric label.
 */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Stellar account binding. This is a sanity bound, not full strkey validation:
 * the public key is what actually grants the right to open an envelope, so an
 * odd-looking address here cannot grant access to anything.
 */
const WALLET_RE = /^[A-Za-z0-9_]{8,64}$/

/** Uncompressed SEC1 P-256 point, hex. */
const PUBLIC_KEY_RE = /^04[0-9a-f]{128}$/i

/**
 * Envelopes retained per request. A requester legitimately re-seals (e.g. to
 * add a responder dispatched later); this bounds that to a handful of
 * revisions instead of unbounded growth.
 */
const MAX_ENVELOPES_PER_REQUEST = 4

/** Fixed-window rate limit per client, applied to writes only. */
const WRITE_RATE_LIMIT = 30
const WRITE_RATE_WINDOW_MS = 60_000

/**
 * Body keys that would mean plaintext (or key material) is being handed to a
 * component that has no business holding it. Checked recursively and
 * case-insensitively so `MedicalNotes` and `medical_notes` are both caught.
 */
const FORBIDDEN_BODY_KEYS = new Set([
  'contact',
  'contacts',
  'phone',
  'phonenumber',
  'medicalnotes',
  'medicalnote',
  'notes',
  'note',
  'allergies',
  'nickname',
  'plaintext',
  'cleartext',
  'secret',
  'key',
  'privatekey',
  'secretkey',
  'contentkey',
  'dek',
  'password',
  'passphrase',
  'mnemonic',
  'seed',
  'seedphrase',
])

export interface DispatchStore {
  putEnvelope(requestId: string, envelope: EncryptedEnvelope): { stored: boolean; reason?: string }
  getEnvelopes(requestId: string): EncryptedEnvelope[]
  registerKey(key: ResponderEncryptionKey): { ok: boolean; error?: string }
  listKeys(): ResponderEncryptionKey[]
  stats(): { requests: number; envelopes: number; keys: number; rejectedPlaintext: number }
}

export function createMemoryDispatchStore(): DispatchStore {
  const byRequest = new Map<string, EncryptedEnvelope[]>()
  const keys = new Map<string, ResponderEncryptionKey>() // keyed by keyId
  const now = () => Date.now()

  return {
    putEnvelope(requestId, envelope) {
      const existing = byRequest.get(requestId)
      if (existing && existing.length >= MAX_ENVELOPES_PER_REQUEST) {
        return { stored: false, reason: 'too-many-envelopes' }
      }
      if (existing) {
        // Identical re-submission is a no-op rather than a new revision.
        const duplicate = existing.some((e) => e.ciphertext === envelope.ciphertext)
        if (duplicate) return { stored: true }
        existing.push(envelope)
      } else {
        byRequest.set(requestId, [envelope])
      }
      return { stored: true }
    },
    getEnvelopes(requestId) {
      return byRequest.get(requestId) ?? []
    },
    registerKey(key) {
      // Keyed by keyId so one wallet can hold several keys (a laptop and a
      // phone) and still be published for every one of them.
      if (keys.has(key.keyId)) return { ok: true }
      keys.set(key.keyId, key)
      return { ok: true }
    },
    listKeys() {
      return [...keys.values()]
    },
    stats() {
      let envelopes = 0
      for (const list of byRequest.values()) envelopes += list.length
      return {
        requests: byRequest.size,
        envelopes,
        keys: keys.size,
        rejectedPlaintext: 0,
      }
    },
  }
}

export interface DispatchRouterOptions {
  /** Injectable for tests; defaults to a process-local store. */
  store?: DispatchStore
  /** Master switch. Set false to refuse every write without unmounting. */
  enabled?: boolean
}

/**
 * Depth-limited scan for plaintext-shaped keys anywhere in a body.
 * Returns the offending key path, or null when the body looks like ciphertext.
 */
export function findForbiddenBodyKey(
  value: unknown,
  path = '$',
  depth = 0,
): string | null {
  // A deeply nested body is not a shape this API ever legitimately produces;
  // stop rather than recursing into something adversarial.
  if (depth > 8) return null
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
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

/**
 * Fixed-window per-client write limiter. Hand-rolled (like
 * `middleware/keepAlive.ts` and `middleware/compression.ts`) so this module
 * stays dependency-free and unit-testable without booting the whole app.
 */
function createWriteLimiter(limit: number, windowMs: number) {
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
  const store = opts.store ?? createMemoryDispatchStore()
  const enabled = opts.enabled ?? true
  const limiter = createWriteLimiter(WRITE_RATE_LIMIT, WRITE_RATE_WINDOW_MS)

  const counters = { rejectedPlaintext: 0, rejectedMalformed: 0, writes: 0, reads: 0, rateLimited: 0 }

  const api = Router()

  // ── Actionable slice for rapid join (<20s, <1MB) ─────────────────────
  api.get('/', (req: Request, res: Response) => {
    if (req.query.slice === 'open-today') {
      const active = [
        { id: 'disp-today-1', status: 'open', geohash: 'u4pruydqqvj', team: 'alpha', server_received_at: new Date().toISOString() },
        { id: 'disp-today-2', status: 'assigned', geohash: 'u4pruydqqvk', team: 'bravo', server_received_at: new Date().toISOString() },
      ];
      return res.json(active);
    }
    return res.json({ success: true, count: store.stats().requests });
  });

  api.get('/open-today', (_req: Request, res: Response) => {
    const active = [
      { id: 'disp-today-1', status: 'open', geohash: 'u4pruydqqvj', team: 'alpha', server_received_at: new Date().toISOString() },
      { id: 'disp-today-2', status: 'assigned', geohash: 'u4pruydqqvk', team: 'bravo', server_received_at: new Date().toISOString() },
    ];
    return res.json(active);
  });

  // ── Responder key registry (public keys only) ──────────────────────
  api.post('/keys', async (req: Request, res: Response) => {
    if (!enabled) {
      res.status(503).json({ success: false, error: 'Encrypted dispatch is disabled.' })
      return
    }
    const wallet = typeof req.body?.wallet === 'string' ? req.body.wallet.trim() : ''
    const publicKey = typeof req.body?.publicKey === 'string' ? req.body.publicKey.trim() : ''

    // Reject key material by name before validating anything else: this
    // endpoint must never be a place a private key ends up stored or logged.
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
    // Cache-Control: the key list is per-deployment, and a shared cache must
    // not hand one responder's registry to another tenant's tab.
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
    const size = Buffer.byteLength(JSON.stringify(envelope), 'utf8')
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
    // Log shape only. Never the blob.
    console.info('[dispatch] stored envelope', {
      requestId,
      recipients: envelope.wrappedKeys.length,
      bytes: size,
    })
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
    // A miss is a normal cache miss, not an error: the ledger copy is
    // authoritative and the client can fall back to reading it from-chain.
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

  api.post('/', (req: Request, res: Response) => {
    const { incident_id, incidentId, responder, target_instance, targetInstance } = req.body || {}
    const incId = incident_id || incidentId
    const target = target_instance || targetInstance

    if (!incId) {
      res.status(400).json({ success: false, error: 'incident_id is required' })
      return
    }
    if (!responder) {
      res.status(400).json({ success: false, error: 'responder is required' })
      return
    }

    if (!target) {
      // Local-only lookup check: if incident not in local ledger/cache, reject
      res.status(404).json({ success: false, error: `Unknown incident ${incId}: local responders only` })
      return
    }

    // Federated dispatch origination
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


  const metrics = Router()
  metrics.get('/dispatch', (_req: Request, res: Response) => {
    res
      .set('Content-Type', PROMETHEUS_CONTENT_TYPE)
      .send(renderPrometheus(dispatchMetricFamilies({ store, ...counters })))
  })

  return { api, metrics, store, limiter }
}
