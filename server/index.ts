import express from 'express'
import cors from 'cors'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { requestLogger } from './middleware/logger.js'
import { generalLimiter } from './middleware/rateLimiter.js'
import { notFoundHandler, globalErrorHandler } from './middleware/errorHandler.js'
import { zkRouter } from './routes/zk.js'
import { requestMetrics } from './middleware/metrics.ts'
import { createSupplyChainRouters } from './routes/supplyChainSecurity.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
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

let _noir = null
let _backend = null
let _ready = false
let _readyPromise = null

async function ensureProver() {
  if (_ready) return
  if (!_readyPromise) {
    _readyPromise = initProver()
  }
  return _readyPromise
}

async function initProver() {
  const { Noir } = await import('@noir-lang/noir_js')
  const { UltraHonkBackend } = await import('@aztec/bb.js')
  const { cpus } = await import('os')

// Supply chain security index, dashboard and Prometheus metrics (#600)
const supplyChain = createSupplyChainRouters()
app.use('/api/supply-chain', supplyChain.api)
app.use('/metrics', supplyChain.metrics)

// ── Responder availability (Issue #156) ───────────────────────────────────────
// In-memory store; production would use a database.
const responderStatusStore = new Map<string, { active: boolean; updatedAt: number }>()

  _noir = new Noir(circuit)
  _backend = new UltraHonkBackend(
    circuit.bytecode,
    { threads: Math.max(1, cpus().length - 1) }
  )

  console.log('[prover] Warming CRS...')
  await _backend.instantiate()
  _ready = true
  console.log('[prover] Ready')
}

function health(_req, res) {
  let poolStats = null
  try { poolStats = getPool().getStats() } catch {}
  res.json({
    status: _ready ? 'ready' : 'warming',
    ready: _ready,
    pool: poolStats,
    compression: { threshold: 1024, encodings: ['br', 'gzip'] },
  })
}

app.get('/health', health)
app.get('/zk/health', health)

// Extra observability: GET /health/pool exposes pool stats directly
app.get('/health/pool', (req, res) => {
  try {
    const stats = getPool().monitor()
    res.json({ ok: true, pool: stats })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/zk/prove', async (req, res) => {
  try {
    const { inputs } = req.body
    if (!inputs) {
      return res.status(400).json({ success: false, error: 'Missing inputs' })
    }

    await ensureProver()
    const start = Date.now()

    const { witness, returnValue } = await _noir.execute(inputs)
    const proofResult = await _backend.generateProof(witness)
    const { proof } = proofResult

    const nullifier = typeof returnValue === 'string' ? returnValue : String(returnValue)

    console.log(`[prover] Proof generated in ${((Date.now() - start) / 1000).toFixed(1)}s`)

    res.json({
      success: true,
      proof: Buffer.from(proof).toString('hex'),
      nullifier,
    })
  } catch (err) {
    console.error('[prover] Error:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`ZK Prover on http://localhost:${PORT}`)
  ensureProver().catch(err => console.error('[prover] Init failed:', err))
})
