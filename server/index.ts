import express, { Request, Response } from 'express'
import cors from 'cors'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  rpc,
  TransactionBuilder,
  Operation,
  Account,
  Keypair,
  BASE_FEE,
  Networks,
  nativeToScVal,
  SorobanDataBuilder,
} from '@stellar/stellar-sdk'
import { SorobanStateExporter, loadLatestSnapshot } from './indexer/exporter.js'
import { authMiddleware } from './middleware/auth.js'
import { createCspMiddleware, createHtmlHandler } from './middleware/csp.js'
import {
  createHttp2PushMiddleware,
  optionsFromEnv as http2PushOptionsFromEnv,
} from './middleware/http2Push.js'
import { createPasskeyAuthRouter } from './routes/passkey-auth.js'
import { createFederationRouter } from './routes/federation.js'
import { createDispatchRouters } from './routes/dispatch.js'
import { syncRouter } from './routes/sync.js'
import historyRouter from './routes/history.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001

// Reuse TCP sockets across sequential requests (see middleware/keepAlive.ts)
app.use(keepAliveMiddleware())

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',')
      : ['https://helphone.com', 'https://staging.helphone.com', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'OPTIONS'],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })
)
app.use(createCspMiddleware())
app.use(express.json({ limit: '1mb' }))

// Behind a proxy (Render), req.ip is the proxy unless TRUST_PROXY is set to the
// number of hops (e.g. "1"); whitelist matching and rate limiting both use it.
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY)
  app.set('trust proxy', Number.isNaN(hops) ? process.env.TRUST_PROXY : hops)
}

// Verified emergency-service subnets / API keys bypass rate limiting. The
// whitelist must run before the limiter, which honours `req.bypassRateLimit`.
export const whitelistStore = createWhitelistStore(createDefaultRedisClient())
const whitelist = createWhitelistMiddleware(whitelistStore)
app.use(whitelist)
app.use(
  '/admin/whitelist',
  createWhitelistAdminRouter({
    store: whitelistStore,
    adminToken: process.env.WHITELIST_ADMIN_TOKEN,
    onChange: () => whitelist.invalidate(),
  })
)
if (process.env.NODE_ENV !== 'test') app.use(generalLimiter)
app.use('/api/auth/passkey', createPasskeyAuthRouter())
const dispatchRouters = createDispatchRouters()
app.use('/api/dispatch', dispatchRouters.api)
app.use('/metrics', dispatchRouters.metrics)
app.use('/api/sync', syncRouter)
app.use('/api/history', historyRouter)
app.use('/api/federation', createFederationRouter())

const stateExporter = new SorobanStateExporter()

// Health Check Endpoints
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', server: 'helphone-indexer-server', timestamp: new Date().toISOString() })
})

app.get('/zk/health', (_req: Request, res: Response) => {
  res.json({ status: 'ready', ready: true })
})

// Soroban State Export Endpoints
app.post('/api/state/export', async (_req: Request, res: Response) => {
  try {
    const snapshot = await stateExporter.exportState()
    res.json({ success: true, snapshot })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/api/state/snapshots/latest', (_req: Request, res: Response) => {
  try {
    const snapshot = loadLatestSnapshot()
    if (!snapshot) {
      return res.status(404).json({ success: false, error: 'No snapshots available' })
    }
    res.json({ success: true, snapshot })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// Secure Authenticated Endpoint Example using Cryptographic Auth Middleware
app.post('/api/protected/action', authMiddleware, (req: Request, res: Response) => {
  res.json({ success: true, message: 'Authenticated payload verified successfully', user: (req as any).authenticatedUser })
})

// Built frontend (nonce-injected HTML). Only active when `vite build` output
// exists, so an API-only deployment keeps behaving exactly as before.
const DIST_DIR = join(__dirname, '..', 'dist')

// HTTP/2 push / preload hints for the built entry chunks
// (see middleware/http2Push.ts). Reads dist/.vite/manifest.json at startup and
// re-reads it whenever a release changes the asset hashes, so the `Link`
// header always matches the files that were actually deployed.
app.use(createHttp2PushMiddleware({ ...http2PushOptionsFromEnv(process.env, { distDir: DIST_DIR }) }))
app.use(express.static(DIST_DIR, { index: false }))
app.get(/^\/(?!api\/|zk\/|health$|metrics).*/, createHtmlHandler({ htmlPath: join(DIST_DIR, 'index.html') }))

// Automated Daily State Snapshot Cron (Interval fallback)
const CRON_INTERVAL_MS = 24 * 60 * 60 * 1000
let exporterInterval: NodeJS.Timeout | null = null

function scheduleStateBackup() {
  console.log('[server] Initializing Soroban Contract State Daily Backup Cron...')
  stateExporter.exportState().catch((err) => console.error('[server] Initial state backup error:', err))

  exporterInterval = setInterval(() => {
    console.log('[server] Executing scheduled daily state snapshot export...')
    stateExporter.exportState().catch((err) => console.error('[server] Scheduled state backup error:', err))
  }, CRON_INTERVAL_MS)
}

if (process.env.NODE_ENV !== 'test') {
  // Apply schema migrations automatically at boot so the database schema
  // stays in sync on every deploy (non-fatal; server serves even on failure).
  void runMigrationsAtStartup()

  const server = app.listen(PORT, () => {
    console.log(`HelPhone Server running on http://localhost:${PORT}`)
    // Off-peak VACUUM ANALYZE / REINDEX CONCURRENTLY (opt-in: DB_MAINTENANCE_ENABLED=true)
    if (getMaintenanceConfig().enabled) startMaintenanceScheduler()
    scheduleStateBackup()
  })
  applyKeepAliveTuning(server)
}
