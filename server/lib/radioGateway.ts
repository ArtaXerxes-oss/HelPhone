/**
 * Server-side radio gateway (#939).
 *
 * Gateway stations decode radio frames (src/lib/radio/protocol.js) and relay the
 * payload here. The client already redacts before transmitting, but this module
 * does not rely on that: it enforces the band plan itself (defense in depth).
 *
 * - Ham (Part 97): plaintext only. Every key must be in HAM_WIRE_FIELDS, no key
 *   may be in PII_FIELDS, and no string value may look like an email or phone
 *   number. A violation is refused and only the offending field NAMES are reported,
 *   never the values.
 * - Licensed (Part 90): AEAD ciphertext keyed to the station. The gateway holds no
 *   key, so licensed relays are refused rather than stored opaque.
 * - Fragments are reassembled per (band, msgId) with a bounded buffer and a TTL.
 * - A completed message dispatches exactly once. The incident id is derived from
 *   (band, msgId), and the domain store refuses a duplicate id, so a re-relay
 *   after the completed set has been evicted still cannot open a second incident.
 */

import type { DomainStore, Priority } from './domainStore.ts'

/**
 * Mirrors HAM_WIRE_FIELDS and PII_FIELDS in src/lib/radio/bandPlan.js. Kept as a
 * local copy because bandPlan.js has no type declarations for the server build.
 * test/radio-gateway.test.js fails if the two lists drift apart.
 */
export const HAM_WIRE_FIELD_NAMES = ['v', 't', 'g', 's', 'id', 'ts', 'from', 'to'] as const
export const PII_FIELD_NAMES = [
  'name',
  'phone',
  'notes',
  'address',
  'contact',
  'lat',
  'lng',
  'lon',
  'wallet',
  'email',
  'nickname',
] as const

/** protocol.js: 150-byte frame − 10-byte header − 2-byte CRC. */
export const MAX_CHUNK_BYTES = 138
const REASSEMBLY_TTL_MS = 120_000
const MAX_PENDING_MESSAGES = 512
const MAX_COMPLETED = 10_000
const MAX_AUDIT_ENTRIES = 500

/** Same contact-shaped patterns the offline queue uses at its own boundary. */
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/
/** Triage codes emitted by bandPlan.js triageCode(). */
const TRIAGE_CODES = new Set(['MED', 'FAL', 'LOS', 'CAR', 'UNF', 'OTH'])
const GRID_RE = /^[A-R]{2}[0-9]{2}[A-X]{2}$/
const MAIDENHEAD_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

const PII_SET = new Set<string>(PII_FIELD_NAMES)
const HAM_SET = new Set<string>(HAM_WIRE_FIELD_NAMES)

export interface HamWire {
  v: number
  t: string
  g: string
  s: number
  id: string
  ts: number
  from?: string
  to?: string
}

export type HamCheck =
  | { ok: true; wire: HamWire }
  | { ok: false; reason: string; fields: string[] }

/**
 * Band-plan check for a decoded ham payload. Returns field names only: echoing a
 * value back would re-transmit the PII the check is there to stop.
 */
export function checkHamWire(value: unknown): HamCheck {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'not_an_object', fields: [] }
  }
  const obj = value as Record<string, unknown>

  const pii: string[] = []
  const unknown: string[] = []
  for (const [key, field] of Object.entries(obj)) {
    const name = key.slice(0, 32)
    if (PII_SET.has(key)) {
      pii.push(name)
      continue
    }
    if (!HAM_SET.has(key)) {
      unknown.push(name)
      continue
    }
    if (typeof field === 'string' && (EMAIL_RE.test(field) || PHONE_RE.test(field))) {
      pii.push(name)
    }
  }
  if (pii.length > 0) return { ok: false, reason: 'band_plan_pii', fields: pii }
  if (unknown.length > 0) return { ok: false, reason: 'unknown_field', fields: unknown }

  const { v, t, g, s, id, ts, from, to } = obj
  if (v !== 1) return { ok: false, reason: 'bad_version', fields: ['v'] }
  if (typeof t !== 'string' || !TRIAGE_CODES.has(t)) return { ok: false, reason: 'bad_triage', fields: ['t'] }
  if (typeof g !== 'string' || !GRID_RE.test(g)) return { ok: false, reason: 'bad_grid', fields: ['g'] }
  if (typeof s !== 'number' || !Number.isInteger(s) || s < 1 || s > 3) {
    return { ok: false, reason: 'bad_severity', fields: ['s'] }
  }
  if (typeof id !== 'string' || id.length < 1 || id.length > 12 || EMAIL_RE.test(id) || PHONE_RE.test(id)) {
    return { ok: false, reason: 'bad_id', fields: ['id'] }
  }
  if (typeof ts !== 'number' || !Number.isInteger(ts) || ts < 0) {
    return { ok: false, reason: 'bad_timestamp', fields: ['ts'] }
  }
  let fromCall: string | undefined
  if (from !== undefined) {
    if (typeof from !== 'string' || from.length > 9) return { ok: false, reason: 'bad_callsign', fields: ['from'] }
    fromCall = from
  }
  let toCall: string | undefined
  if (to !== undefined) {
    if (typeof to !== 'string' || to.length > 9) return { ok: false, reason: 'bad_callsign', fields: ['to'] }
    toCall = to
  }

  return { ok: true, wire: { v: 1, t, g, s, id, ts, from: fromCall, to: toCall } }
}

/** Centre of a 6-character Maidenhead square, the inverse of bandPlan.toGridSquare(). */
export function gridSquareCenter(grid: string): { lat: number; lng: number } {
  const idx = (ch: string) => MAIDENHEAD_LETTERS.indexOf(ch)
  const lonField = idx(grid[0])
  const latField = idx(grid[1])
  const lonSquare = Number(grid[2])
  const latSquare = Number(grid[3])
  const lonSub = idx(grid[4])
  const latSub = idx(grid[5])
  return {
    lng: lonField * 20 - 180 + lonSquare * 2 + (lonSub + 0.5) / 12,
    lat: latField * 10 - 90 + latSquare + (latSub + 0.5) / 24,
  }
}

export function severityToPriority(severity: number): Priority {
  if (severity >= 3) return 'critical'
  if (severity === 2) return 'high'
  return 'normal'
}

export function radioIncidentId(band: string, msgId: number): string {
  return `RAD-${band === 'ham' ? 'H' : 'L'}${(msgId >>> 0).toString(16).padStart(8, '0')}`
}

export interface RelayFragment {
  gatewayId: string
  band: 'ham' | 'licensed'
  msgId: number
  fragIdx: number
  fragCount: number
  chunkB64: string
}

export interface RelayOutcome {
  status: number
  body: Record<string, unknown>
}

export interface RadioAuditEntry {
  at: number
  gatewayId: string
  band: string
  msgId: number
  outcome: string
  fields?: string[]
}

interface Pending {
  fragCount: number
  frags: Map<number, Uint8Array>
  startedAt: number
}

export interface RadioGatewayOptions {
  store: Pick<DomainStore, 'createIncident'>
  now?: () => number
}

export function createRadioGateway({ store, now = () => Date.now() }: RadioGatewayOptions) {
  const pending = new Map<string, Pending>()
  const completed = new Map<string, string>()
  const audit: RadioAuditEntry[] = []

  const record = (entry: Omit<RadioAuditEntry, 'at'>) => {
    audit.push({ at: now(), ...entry })
    if (audit.length > MAX_AUDIT_ENTRIES) audit.splice(0, audit.length - MAX_AUDIT_ENTRIES)
  }

  const purgeExpired = () => {
    const t = now()
    for (const [key, bucket] of pending) {
      if (t - bucket.startedAt > REASSEMBLY_TTL_MS) pending.delete(key)
    }
  }

  /** Add one fragment. Returns the reassembled payload once every fragment is present. */
  const addFragment = (key: string, input: RelayFragment, chunk: Uint8Array) => {
    purgeExpired()
    let bucket = pending.get(key)
    if (!bucket) {
      if (pending.size >= MAX_PENDING_MESSAGES) {
        const oldest = pending.keys().next().value
        if (oldest !== undefined) pending.delete(oldest)
      }
      bucket = { fragCount: input.fragCount, frags: new Map(), startedAt: now() }
      pending.set(key, bucket)
    }
    if (bucket.fragCount !== input.fragCount) {
      pending.delete(key)
      return { status: 'mismatch' as const }
    }
    if (bucket.frags.has(input.fragIdx)) {
      return { status: 'duplicate' as const, received: bucket.frags.size, fragCount: bucket.fragCount }
    }
    bucket.frags.set(input.fragIdx, chunk)
    if (bucket.frags.size < bucket.fragCount) {
      return { status: 'partial' as const, received: bucket.frags.size, fragCount: bucket.fragCount }
    }
    const parts: Uint8Array[] = []
    for (let i = 0; i < bucket.fragCount; i++) {
      const part = bucket.frags.get(i)
      if (!part) {
        pending.delete(key)
        return { status: 'mismatch' as const }
      }
      parts.push(part)
    }
    pending.delete(key)
    const total = parts.reduce((n, p) => n + p.length, 0)
    const payload = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      payload.set(part, offset)
      offset += part.length
    }
    return { status: 'complete' as const, payload }
  }

  const dispatch = (key: string, input: RelayFragment, payload: Uint8Array): RelayOutcome => {
    let decoded: unknown
    try {
      decoded = JSON.parse(Buffer.from(payload).toString('utf8'))
    } catch {
      record({ gatewayId: input.gatewayId, band: input.band, msgId: input.msgId, outcome: 'malformed' })
      return { status: 422, body: { error: 'malformed_payload' } }
    }

    const check = checkHamWire(decoded)
    if (!check.ok) {
      record({
        gatewayId: input.gatewayId,
        band: input.band,
        msgId: input.msgId,
        outcome: 'band_plan_violation',
        fields: check.fields,
      })
      return {
        status: 422,
        body: { error: 'band_plan_violation', reason: check.reason, fields: check.fields },
      }
    }

    const incidentId = radioIncidentId(input.band, input.msgId)
    let outcome: 'dispatched' | 'duplicate' = 'dispatched'
    try {
      store.createIncident({
        id: incidentId,
        status: 'open',
        priority: severityToPriority(check.wire.s),
        location: gridSquareCenter(check.wire.g),
      })
    } catch (error) {
      // The store already holds this id (completed set evicted, or restart). Still one incident.
      if ((error as { code?: string }).code !== 'conflict') throw error
      outcome = 'duplicate'
    }
    completed.set(key, incidentId)
    if (completed.size > MAX_COMPLETED) {
      const oldest = completed.keys().next().value
      if (oldest !== undefined) completed.delete(oldest)
    }
    record({ gatewayId: input.gatewayId, band: input.band, msgId: input.msgId, outcome })
    if (outcome === 'duplicate') return { status: 200, body: { status: 'duplicate', incidentId } }
    return { status: 201, body: { status: 'dispatched', incidentId } }
  }

  const relay = (input: RelayFragment): RelayOutcome => {
    const key = `${input.band}:${input.msgId}`

    const done = completed.get(key)
    if (done !== undefined) {
      record({ gatewayId: input.gatewayId, band: input.band, msgId: input.msgId, outcome: 'duplicate' })
      return { status: 200, body: { status: 'duplicate', incidentId: done } }
    }

    if (input.band === 'licensed') {
      record({ gatewayId: input.gatewayId, band: input.band, msgId: input.msgId, outcome: 'licensed_refused' })
      return { status: 422, body: { error: 'licensed_band_not_relayable' } }
    }

    const chunk = new Uint8Array(Buffer.from(input.chunkB64, 'base64'))
    if (chunk.length === 0 || chunk.length > MAX_CHUNK_BYTES) {
      return { status: 422, body: { error: 'invalid_chunk' } }
    }

    const step = addFragment(key, input, chunk)
    switch (step.status) {
      case 'mismatch':
        record({ gatewayId: input.gatewayId, band: input.band, msgId: input.msgId, outcome: 'fragment_mismatch' })
        return { status: 409, body: { error: 'fragment_mismatch' } }
      case 'duplicate':
        return {
          status: 202,
          body: { status: 'duplicate_fragment', received: step.received, fragCount: step.fragCount },
        }
      case 'partial':
        return { status: 202, body: { status: 'partial', received: step.received, fragCount: step.fragCount } }
      case 'complete':
        return dispatch(key, input, step.payload)
    }
  }

  return {
    relay,
    audit: () => audit.map((entry) => ({ ...entry })),
    pendingCount: () => {
      purgeExpired()
      return pending.size
    },
  }
}

export type RadioGateway = ReturnType<typeof createRadioGateway>
