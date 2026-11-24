import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Server-side verification of NFC / QR staging check-ins (#940).
 *
 * The device verifies a staging payload offline as a cheap pre-filter. This
 * gateway is the authoritative check. It re-derives the HMAC with the server
 * secret, rejects stale or forged payloads, refuses revoked staging IDs, and
 * treats a replayed nonce as a duplicate. A duplicate is still answered 200
 * so the offline queue drains exactly once.
 *
 * Nonce memory is per process. A multi-instance deployment needs a shared
 * store before duplicate detection is exact across instances.
 */

export const STAGING_MAX_SKEW_SEC = 86_400
const NONCE_MEMORY = 10_000

export type StagingOutcome =
  | 'accepted'
  | 'duplicate'
  | 'revoked'
  | 'forged'
  | 'stale'
  | 'malformed'
  | 'unconfigured'

export interface StagingCheckInResult {
  status: number
  body: { outcome: StagingOutcome; stagingId?: string }
}

export interface StagingGatewayOptions {
  /** Server-side staging secret (hex string, as provisioned to tags). Unset → fail closed. */
  secretHex?: string
  revokedStagingIds?: Iterable<string>
  now?: () => number
  maxSkewSec?: number
}

export interface StagingGateway {
  checkIn(payload: unknown): StagingCheckInResult
}

interface StagingRecord {
  v: 1
  stagingId: string
  nonce: string
  ts: number
  hmac: string
}

const STATUS: Record<StagingOutcome, number> = {
  accepted: 201,
  duplicate: 200,
  revoked: 409,
  forged: 422,
  stale: 422,
  malformed: 422,
  unconfigured: 503,
}

const STAGING_ID = /^[A-Za-z0-9_-]{1,64}$/
const NONCE = /^[0-9a-f]{8,64}$/i
const HMAC_HEX = /^[0-9a-f]{64}$/

function respond(outcome: StagingOutcome, stagingId?: string): StagingCheckInResult {
  return { status: STATUS[outcome], body: stagingId ? { outcome, stagingId } : { outcome } }
}

/** Accepts the signed JSON string or an already-parsed object. Anything else is malformed. */
export function parseStagingRecord(payload: unknown): StagingRecord | null {
  let value: unknown = payload
  if (typeof payload === 'string') {
    try {
      value = JSON.parse(payload)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  if (r.v !== 1) return null
  if (typeof r.stagingId !== 'string' || !STAGING_ID.test(r.stagingId)) return null
  if (typeof r.nonce !== 'string' || !NONCE.test(r.nonce)) return null
  if (typeof r.hmac !== 'string' || !HMAC_HEX.test(r.hmac)) return null
  if (typeof r.ts !== 'number' || !Number.isInteger(r.ts)) return null
  return { v: 1, stagingId: r.stagingId, nonce: r.nonce, ts: r.ts, hmac: r.hmac }
}

function hmacMatches(record: StagingRecord, secretHex: string): boolean {
  const expected = createHmac('sha256', secretHex)
    .update(`${record.stagingId}.${record.nonce}.${record.ts}`)
    .digest('hex')
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(record.hmac, 'hex'))
}

export function createStagingGateway(options: StagingGatewayOptions = {}): StagingGateway {
  const secretHex = options.secretHex
  const revoked = new Set([...(options.revokedStagingIds ?? [])].map(String))
  const now = options.now ?? (() => Date.now())
  const maxSkewSec = options.maxSkewSec ?? STAGING_MAX_SKEW_SEC
  const seenNonces = new Set<string>()

  return {
    checkIn(payload: unknown): StagingCheckInResult {
      if (!secretHex) return respond('unconfigured')
      const record = parseStagingRecord(payload)
      if (!record) return respond('malformed')
      if (Math.abs(Math.floor(now() / 1000) - record.ts) > maxSkewSec) return respond('stale', record.stagingId)
      if (!hmacMatches(record, secretHex)) return respond('forged')
      if (revoked.has(record.stagingId)) return respond('revoked', record.stagingId)
      if (seenNonces.has(record.nonce)) return respond('duplicate', record.stagingId)
      seenNonces.add(record.nonce)
      if (seenNonces.size > NONCE_MEMORY) {
        const oldest = seenNonces.values().next().value
        if (oldest !== undefined) seenNonces.delete(oldest)
      }
      return respond('accepted', record.stagingId)
    },
  }
}
