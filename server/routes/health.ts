import { Router } from 'express'

export function createHealthRouter(readiness: () => boolean = () => true) {
  const router = Router()
  router.get('/live', (_req, res) => res.json({ status: 'ok' }))
  router.get('/ready', (_req, res) => {
    const ready = readiness()
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' })
  })
  return router
}
