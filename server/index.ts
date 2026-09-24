import express from 'express'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { normalizeBase64 } from './base64Utils.js'
import { compression } from './middleware/compression.js'
import { logger, poolMonitorMiddleware } from './middleware/logger.js'
import { createCorsMiddleware } from './middleware/cors.js'
import { getPool } from './db/connection.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001

// Performance: Brotli & Gzip dynamic compression (threshold 1KB, bypass binary assets)
app.use(compression({ threshold: 1024, debug: process.env.DEBUG_COMPRESSION === 'true' }))
// Observability: structured logger + pool monitoring
app.use(logger({ slowThresholdMs: 1000 }))
app.use(poolMonitorMiddleware)

// Solves Issue 1: Restrict CORS policy on ZK Prover Server — stateful regex validation + 24h preflight cache
app.use(createCorsMiddleware())
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

  const circuitPath = join(__dirname, '..', 'circuits', 'target', 'aegis.json')
  const circuit = JSON.parse(readFileSync(circuitPath, 'utf-8'))
  circuit.bytecode = normalizeBase64(circuit.bytecode)

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
