import express from 'express'
import cors from 'cors'

import { requestLogger } from './middleware/logger.js'
import { generalLimiter } from './middleware/rateLimiter.js'
import { notFoundHandler, globalErrorHandler } from './middleware/errorHandler.js'
import { zkRouter } from './routes/zk.js'
import { eventsRouter } from './routes/events.js'
import { syncRouter } from './routes/sync.js'

const app = express()
const PORT = Number(process.env.PORT) || 3001

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins: string[] = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['https://helphone.com', 'https://staging.helphone.com']

app.use(
  cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  }),
)
app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Embedder-Policy', process.env.COEP_POLICY || 'credentialless')
  res.setHeader('Origin-Agent-Cluster', '?1')
  next()
})

// ── Global middleware pipeline ────────────────────────────────────────────────
app.use(requestLogger)          // HTTP request logging
app.use(generalLimiter)         // Global rate limiting (100 req/min per IP)
app.use(express.json({ limit: '1mb' }))

// ── Routes ────────────────────────────────────────────────────────────────────

// Legacy health endpoint kept for backward-compat
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.use('/api/events', eventsRouter)
app.use('/api/sync', syncRouter)
// ZK prover routes mounted at /zk
app.use('/zk', zkRouter)

// ── Responder availability (Issue #156) ───────────────────────────────────────
// In-memory store; production would use a database.
const responderStatusStore = new Map<string, { active: boolean; updatedAt: number }>()

app.get('/api/responder-status/:address', (req, res) => {
  const { address } = req.params
  const entry = responderStatusStore.get(address)
  res.json({ address, active: entry?.active ?? true, updatedAt: entry?.updatedAt ?? null })
})

app.post('/api/responder-status/:address', (req, res) => {
  const { address } = req.params
  const { active } = req.body
  if (typeof active !== 'boolean') {
    res.status(400).json({ error: 'active must be a boolean' })
    return
  }
  responderStatusStore.set(address, { active, updatedAt: Date.now() })
  res.json({ address, active, updatedAt: Date.now() })
})

// ── Error handling (must come last) ──────────────────────────────────────────
app.use(notFoundHandler)
app.use(globalErrorHandler)

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ZK Prover on http://localhost:${PORT}`)
  // Warm prover in the background — don't block startup
  import('./routes/zk.js')
    .then(() => console.log('[prover] Route module loaded'))
    .catch((err: unknown) =>
      console.error('[prover] Init failed:', err),
    )
})
