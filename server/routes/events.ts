import { Router } from 'express'
export const eventsRouter = Router()
eventsRouter.get('/ice-config', (_req, res) => {
  const urls = (process.env.TURN_URLS || '').split(',').map((v) => v.trim()).filter(Boolean)
  res.set('Cache-Control', 'no-store').json({
    iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }, ...(urls.length ? [{ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }] : [])],
    fallback: { transport: 'websocket', endpoint: '/api/events/frame-stream' },
  })
})
eventsRouter.post('/ice-metrics', (req, res) => {
  const { gatheringMs, success, hasRelay } = req.body || {}
  if (!Number.isFinite(gatheringMs) || typeof success !== 'boolean' || typeof hasRelay !== 'boolean') { res.status(400).json({ error: 'invalid ICE metric' }); return }
  console.info('[ice-metric]', { gatheringMs, success, hasRelay })
  res.status(202).json({ accepted: true })
})
