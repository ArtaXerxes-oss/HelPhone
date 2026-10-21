import { Router } from 'express'
import { z } from 'zod'
import { getDomainStore, type DomainStore } from '../lib/domainStore.ts'
import { invalidateIncident } from '../lib/sqlCache.ts'

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
export function createSyncRouter(options: { store?: DomainStore } = {}): Router {
  const store = options.store ?? getDomainStore()
  const router = Router()

  router.post('/', (req, res) => {
    const incoming = Array.isArray(req.body?.operations) ? req.body.operations : []
    for (const op of incoming) {
      if (typeof op?.actor !== 'string' || !Number.isSafeInteger(op?.counter) || op.counter < 1) continue
      operations.set(`${op.actor}:${op.counter}`, op)
    }
    res.json({ operations: [...operations.values()] })
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

  return router
}

export const syncRouter = createSyncRouter()
