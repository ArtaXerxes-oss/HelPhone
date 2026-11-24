import { Router } from 'express'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { getDomainStore, type DomainStore } from '../lib/domainStore.ts'
import { invalidateIncident } from '../lib/sqlCache.ts'
import {
  LwwElementSet,
  STATUS_LATTICE_RANK,
  PRIORITY_LATTICE_RANK,
} from '../../src/lib/crdt.js'
import type { LwwOperation, VectorClock } from '../../src/lib/crdt.js'
import { computeReconciliationMerge, type AnnotatedOperation } from '../../src/lib/crdtAdvanced.js'
import { isValidVector, stateDigest, sumVector } from '../../src/lib/syncIntegrity.js'
import { compareForPaging, cutPage } from '../../src/lib/syncPaging.js'

export const localCrdtStore = new LwwElementSet('server-sync', process.env.TENANT || 'local')

// Track committed (device_id, seq) for idempotency across crashes / re-uploads
const committedDeviceSeq = new Set<string>()

export function clearCommittedDeviceSeq(): void {
  committedDeviceSeq.clear()
}

type Operation = { key: string; value?: unknown; deleted: boolean; actor: string; counter: number; timestamp: number }
const operations = new Map<string, Operation>()

const flushSchema = z.object({
  incidentId: z.string().min(1),
  baseVersion: z.number().int().positive(),
  patch: z.record(z.unknown()),
})

/**
 * Offline outbox sync + CRDT operations.
 *
 * `POST /flush` is the canonical conflict contract:
 *   200 { ok, serverVersion, incident }
 *   409 { conflict, serverVersion, mergeProposal }   ← same as GraphQL SyncConflict
 *   422 { error, issues[] }                          ← same as GraphQL ValidationError
 */
export interface ConflictAuditEntry {
  key: string
  actor: string
  reason: string
  zone?: string
  epoch?: number
  timestamp: number
}

const conflictAuditLog: ConflictAuditEntry[] = []
const MAX_CONFLICT_AUDIT_LOG = 500

export function getConflictAuditLog(): ConflictAuditEntry[] {
  return [...conflictAuditLog]
}

function parseConflictString(conflict: string, zone?: string, epoch?: number): ConflictAuditEntry {
  const keyMatch = /key=([^:]+)/.exec(conflict)
  const actorMatch = /actor=([^:]+)/.exec(conflict)
  const reasonIdx = conflict.indexOf('actor=')
  const reason =
    reasonIdx !== -1
      ? conflict.slice(conflict.indexOf(':', reasonIdx) + 1)
      : conflict
  return {
    key: keyMatch?.[1] ?? 'unknown',
    actor: actorMatch?.[1] ?? 'unknown',
    reason,
    zone,
    epoch,
    timestamp: Date.now(),
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const DEFAULT_PAGE_LIMIT = 500
const MAX_PAGE_LIMIT = 1000
/** Base snapshots are compacted and rebuilt at most once an hour (#930). */
export const SNAPSHOT_TTL_MS = 60 * 60 * 1000

/** Parses `since_vector`. Absent means "from zero"; malformed means null (400). */
export function parseSinceVector(raw: unknown): VectorClock | null {
  if (raw === undefined) return {}
  if (typeof raw !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isValidVector(parsed) ? (parsed as VectorClock) : null
  } catch {
    return null
  }
}

export interface CompactedSnapshot {
  snapshot_id: string
  built_at: number
  vector: VectorClock
  seq_highwater: number
  checksum: string
  operations: LwwOperation[]
}

let snapshotCache: CompactedSnapshot | null = null

/**
 * Hourly compacted base snapshot (#930). Holds the winning operation per key,
 * tombstones included, plus the vector taken at the same instant, so the two
 * always describe the same state. A cached copy is older, never inconsistent:
 * clients page the deltas since its vector.
 */
export function getCompactedSnapshot(now = Date.now()): CompactedSnapshot {
  if (snapshotCache && now - snapshotCache.built_at < SNAPSHOT_TTL_MS) return snapshotCache
  const snap = localCrdtStore.snapshot()
  const operations = snap.entries as LwwOperation[]
  snapshotCache = {
    snapshot_id: `snapshot-${now}`,
    built_at: now,
    vector: snap.clock,
    seq_highwater: operations.length,
    checksum: sha256(JSON.stringify(operations)),
    operations,
  }
  return snapshotCache
}

export function clearCompactedSnapshot(): void {
  snapshotCache = null
}

/** Convergence digest that clients compare against their own join receipts (#932). */
export function getStateDigest(): { highwater: number; hash: string } {
  return {
    highwater: sumVector(localCrdtStore.clock),
    hash: stateDigest(new Map(localCrdtStore.values())),
  }
}

export function createSyncRouter(options: { store?: DomainStore } = {}): Router {
  const store = options.store ?? getDomainStore()
  const router = Router()

  router.post('/', (req, res) => {
    const incoming: (AnnotatedOperation & { device_id?: string; seq?: number })[] = Array.isArray(req.body?.operations)
      ? req.body.operations
      : []
    const zone = typeof req.body?.zone === 'string' ? req.body.zone : undefined
    const epoch = typeof req.body?.epoch === 'number' ? req.body.epoch : undefined
    let allDeduped = incoming.length > 0

    const validIncoming: AnnotatedOperation[] = []
    for (const op of incoming) {
      if (op?.device_id && op?.seq !== undefined) {
        const dedupKey = `${op.device_id}:${op.seq}`
        if (committedDeviceSeq.has(dedupKey)) {
          continue
        }
        committedDeviceSeq.add(dedupKey)
        allDeduped = false
      } else {
        allDeduped = false
      }

      if (typeof op?.actor !== 'string' || !Number.isSafeInteger(op?.counter) || op.counter < 1) continue
      validIncoming.push(op)
    }

    const localOps = localCrdtStore.snapshot().operations as AnnotatedOperation[]
    const { merged, conflicts } = computeReconciliationMerge(
      localOps,
      validIncoming,
      STATUS_LATTICE_RANK,
      PRIORITY_LATTICE_RANK,
    )

    let appliedAny = false
    for (const op of merged) {
      if (localCrdtStore.apply(op)) {
        appliedAny = true
      }
      operations.set(`${op.actor}:${op.counter}`, op as Operation)
    }

    if (appliedAny && conflicts.length > 0) {
      for (const conflict of conflicts) {
        const entry = parseConflictString(conflict, zone, epoch)
        conflictAuditLog.push(entry)
        if (conflictAuditLog.length > MAX_CONFLICT_AUDIT_LOG) {
          conflictAuditLog.shift()
        }
        console.info('[sync/reconcile] conflict resolved', JSON.stringify(entry))
      }
    }

    const remoteClock: VectorClock = (req.body?.vectorClock as VectorClock) || {}
    const deltas = localCrdtStore.delta(remoteClock)
    const isNoOp = (allDeduped || (!appliedAny && validIncoming.length > 0)) && incoming.length > 0

    if (isNoOp) {
      return res.status(200).json({
        deduped: true,
        operations: deltas.length > 0 ? deltas : merged,
        conflicts: [],
        vectorClock: localCrdtStore.clock,
      })
    }

    res.json({
      operations: deltas.length > 0 ? deltas : merged,
      conflicts,
      vectorClock: localCrdtStore.clock,
    })
  })

  router.get('/conflicts', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      count: conflictAuditLog.length,
      conflicts: getConflictAuditLog(),
    })
  })

  router.post('/flush', (req, res) => {
    const parsed = flushSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || 'body',
          message: issue.message,
        })),
      })
      return
    }

    const result = store.syncFlush(parsed.data)
    if (result.__typename === 'SyncSuccess') {
      invalidateIncident(parsed.data.incidentId)
      res.json({ ok: true, serverVersion: result.serverVersion, incident: result.incident })
      return
    }
    if (result.__typename === 'SyncConflict') {
      res.status(409).json({
        conflict: true,
        serverVersion: result.serverVersion,
        mergeProposal: result.mergeProposal,
      })
      return
    }
    res.status(422).json({ error: result.error, issues: result.issues })
  })

  // Paged deltas (#930). Pages are a global prefix of the delta stream in
  // canonical order, so `next_vector` never skips an operation and a follow-up
  // request never repeats one. `checksum` is SHA-256 of the page's JSON.
  router.get('/deltas', (req, res) => {
    const sinceVector = parseSinceVector(req.query.since_vector)
    if (!sinceVector) {
      res.status(400).json({ error: 'invalid_since_vector' })
      return
    }

    const requested = parseInt(req.query.limit as string, 10) || DEFAULT_PAGE_LIMIT
    const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, requested))
    const ordered = localCrdtStore.delta(sinceVector).sort(compareForPaging)
    const page = cutPage(ordered, limit)

    const next_vector: VectorClock = { ...sinceVector }
    for (const op of page) {
      next_vector[op.actor] = Math.max(next_vector[op.actor] ?? 0, op.counter)
      if (op.instance && op.instance !== 'local') {
        const fk = `${op.instance}:${op.actor}`
        next_vector[fk] = Math.max(next_vector[fk] ?? 0, op.counter)
      }
    }

    res.json({
      operations: page,
      deltas: page, // legacy key, kept for clients that predate #930
      next_vector,
      has_more: page.length < ordered.length,
      total_remaining: ordered.length - page.length,
      checksum: sha256(JSON.stringify(page)),
    })
  })

  // Hourly compacted base snapshot with checksum (#930).
  router.get('/snapshot', (_req, res) => {
    const snap = getCompactedSnapshot()
    res.set('Cache-Control', 'public, max-age=300').json({
      snapshot_id: snap.snapshot_id,
      built_at: snap.built_at,
      vector: snap.vector,
      seq_highwater: snap.seq_highwater,
      checksum: snap.checksum,
      operations: snap.operations,
    })
  })

  // Convergence digest for join receipts (#932).
  router.get('/digest', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(getStateDigest())
  })

  router.get('/open-today', (_req, res) => {
    const vals = localCrdtStore.values()
    const openItems = vals.map(([k, v]) => ({ key: k, value: v }))
    res.json({
      slice: 'open-today',
      count: openItems.length,
      items: openItems,
    })
  })

  router.post('/peer-delta', (req, res) => {
    const peerInstance = req.body?.peerInstance || 'peer'
    const operations: LwwOperation[] = Array.isArray(req.body?.operations) ? req.body.operations : []
    const remoteClock: VectorClock = (req.body?.vectorClock as VectorClock) || {}

    let mergedCount = 0
    for (const op of operations) {
      if (!op || typeof op.actor !== 'string') continue
      const namespacedOp: LwwOperation = {
        ...op,
        instance: op.instance || peerInstance,
        provenance: 'peer_asserted',
      }
      if (localCrdtStore.apply(namespacedOp)) {
        mergedCount++
      }
    }

    const responseDeltas = localCrdtStore.delta(remoteClock)

    res.json({
      success: true,
      mergedCount,
      deltas: responseDeltas,
      vectorClock: localCrdtStore.clock,
    })
  })

  return router
}

export const syncRouter = createSyncRouter()
