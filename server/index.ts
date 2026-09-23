import express from 'express'
import cors from 'cors'

import { requestLogger } from './middleware/logger.js'
import { generalLimiter } from './middleware/rateLimiter.js'
import { notFoundHandler, globalErrorHandler } from './middleware/errorHandler.js'
import { zkRouter } from './routes/zk.js'
import { requestMetrics } from './middleware/metrics.ts'
import { createSupplyChainRouters } from './routes/supplyChainSecurity.ts'

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

// ── Global middleware pipeline ────────────────────────────────────────────────
app.use(requestLogger)          // HTTP request logging
app.use(requestMetrics)         // Prometheus request counters (#600)
app.use(generalLimiter)         // Global rate limiting (100 req/min per IP)
app.use(express.json({ limit: '1mb' }))

// ── Routes ────────────────────────────────────────────────────────────────────

// Legacy health endpoint kept for backward-compat
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// ZK prover routes mounted at /zk
app.use('/zk', zkRouter)

// Supply chain security index, dashboard and Prometheus metrics (#600)
const supplyChain = createSupplyChainRouters()
app.use('/api/supply-chain', supplyChain.api)
app.use('/metrics', supplyChain.metrics)

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
