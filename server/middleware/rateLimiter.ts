import { rateLimit, type Options } from 'express-rate-limit'
import type { Request } from 'express'
import { isWhitelisted } from './whitelist.js'

/**
 * Rate-limit tiers.
 *
 * Proof generation is CPU-intensive; restrict to 10 requests per minute
 * per IP to protect the server from abuse while still allowing
 * legitimate use (a single user rarely needs more than a few proofs/min).
 *
 * The general limiter is mounted on /api after the body parser. Auth and
 * telemetry get tighter budgets, but all tiers return a JSON envelope with
 * Retry-After and the standard draft-7 headers, including for preflight.
 */

export interface LimiterOptions {
  windowMs?: number
  max?: number
  message?: string
  skipSuccessfulRequests?: boolean
  skip?: (req: Request) => boolean
}

export function createLimiter(options: LimiterOptions = {}) {
  const message = options.message ?? 'Too many requests — please slow down and try again shortly.'
  const config: Partial<Options> = {
    windowMs: options.windowMs ?? 60_000,
    max: options.max ?? 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
    skip: options.skip ?? isWhitelisted,
    handler: (_req, res) => {
      res.status(429).json({ success: false, error: message, code: 'rate_limited' })
    },
  }
  return rateLimit(config)
}

/** General API budget: 100 req/min/IP. */
export const generalLimiter = createLimiter({
  windowMs: 60_000,
  max: 100,
  message: 'Too many requests — please slow down and try again shortly.',
})

/** ZK proving is CPU-bound: 10 req/min/IP. */
export const proverLimiter = createLimiter({
  windowMs: 60_000,
  max: 10,
  message: 'ZK prover rate limit exceeded — at most 10 proofs per minute per IP.',
})

/** Telemetry ingest gets a higher rate but its own bucket. */
export const telemetryLimiter = createLimiter({
  windowMs: 60_000,
  max: 240,
  message: 'Telemetry ingest rate limit exceeded.',
})

/** Passkey/session endpoints: 20 req/min/IP. */
export const authLimiter = createLimiter({
  windowMs: 60_000,
  max: 20,
  message: 'Authentication rate limit exceeded.',
})

/** Read-only data API: 300 req/min/IP. */
export const dataLimiter = createLimiter({ windowMs: 60_000, max: 300 })

export const rateLimiters = {
  general: generalLimiter,
  prover: proverLimiter,
  telemetry: telemetryLimiter,
  auth: authLimiter,
  data: dataLimiter,
}

export default createLimiter
