import { Router } from 'express'
type Operation = { key: string; value?: unknown; deleted: boolean; actor: string; counter: number; timestamp: number }
const operations = new Map<string, Operation>()
export const syncRouter = Router()
syncRouter.post('/', (req, res) => {
  const incoming = Array.isArray(req.body?.operations) ? req.body.operations : []
  for (const op of incoming) {
    if (typeof op?.actor !== 'string' || !Number.isSafeInteger(op?.counter) || op.counter < 1) continue
    operations.set(`${op.actor}:${op.counter}`, op)
  }
  res.json({ operations: [...operations.values()] })
})
