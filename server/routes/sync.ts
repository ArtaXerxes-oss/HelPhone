import { Router } from 'express'
import { createHash } from 'node:crypto'
import { LwwElementSet, evaluateConflictWinner } from '../../src/lib/crdt.js'
import type { LwwOperation, VectorClock } from '../../src/lib/crdt.js'

export const localCrdtStore = new LwwElementSet('server-sync', process.env.TENANT || 'local')
export const syncRouter = Router()

// Track committed (device_id, seq) for idempotency across crashes / re-uploads
const committedDeviceSeq = new Set<string>()

export function clearCommittedDeviceSeq(): void {
  committedDeviceSeq.clear()
}

syncRouter.post('/', (req, res) => {
  const incoming: (LwwOperation & { device_id?: string; seq?: number })[] = Array.isArray(req.body?.operations) ? req.body.operations : []
  let allDeduped = incoming.length > 0

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
    localCrdtStore.apply(op)
  }

  const remoteClock: VectorClock = (req.body?.vectorClock as VectorClock) || {}
  const deltas = localCrdtStore.delta(remoteClock)

  if (allDeduped && incoming.length > 0) {
    return res.status(200).json({
      deduped: true,
      operations: deltas.length > 0 ? deltas : localCrdtStore.snapshot().operations,
      vectorClock: localCrdtStore.clock,
    })
  }

  res.json({
    operations: deltas.length > 0 ? deltas : localCrdtStore.snapshot().operations,
    vectorClock: localCrdtStore.clock,
  })
})

syncRouter.get('/deltas', (req, res) => {
  let sinceVector: VectorClock = {}
  try {
    if (typeof req.query.since_vector === 'string') {
      sinceVector = JSON.parse(req.query.since_vector)
    }
  } catch {}

  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit as string, 10) || 500))
  const allDeltas = localCrdtStore.delta(sinceVector)
  const paged = allDeltas.slice(0, limit)
  const has_more = allDeltas.length > limit

  const next_vector: VectorClock = { ...sinceVector }
  for (const op of paged) {
    const k = op.actor
    next_vector[k] = Math.max(next_vector[k] ?? 0, op.counter)
    if (op.instance && op.instance !== 'local') {
      const fk = `${op.instance}:${op.actor}`
      next_vector[fk] = Math.max(next_vector[fk] ?? 0, op.counter)
    }
  }

  const hash = createHash('sha256').update(JSON.stringify(paged)).digest('hex')

  res.json({
    deltas: paged,
    next_vector,
    has_more,
    total_remaining: Math.max(0, allDeltas.length - limit),
    checksum: hash,
  })
})

syncRouter.get('/snapshot', (_req, res) => {
  const snap = localCrdtStore.snapshot()
  const hash = createHash('sha256').update(JSON.stringify(snap.operations)).digest('hex')
  res.set('Cache-Control', 'public, max-age=300').json({
    snapshot_id: `snapshot-${Date.now()}`,
    vector: snap.clock,
    seq_highwater: snap.operations.length,
    checksum: hash,
    operations: snap.operations,
  })
})

syncRouter.get('/open-today', (_req, res) => {
  const vals = localCrdtStore.values()
  const openItems = vals.map(([k, v]) => ({ key: k, value: v }))
  res.json({
    slice: 'open-today',
    count: openItems.length,
    items: openItems,
  })
})

syncRouter.post('/peer-delta', (req, res) => {
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

