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

// ── Rejoin allowlist (#909) ────────────────────────────────────────────────
//
// A WS responder whose socket was reaped by the server while the tab was in
// mobile background must be able to rejoin its active dispatch claim without
// losing it.  Three problems compound without this:
//
//   1. The server reaps the socket and marks the claim unassigned.
//   2. The responder reconnects and POSTs /api/dispatch/rejoin.
//   3. Without an allowlist the rejoin hits the general 100 req/min/IP tier,
//      which a flood of rapid reconnects (poor signal, aggressive app-switcher)
//      can exhaust, locking out the legitimate responder.
//
// The allowlist gates rejoin requests by authenticated session ID.  On first
// rejoin the session is admitted and its backoff counter is reset.  Flood
// detection (> REJOIN_FLOOD_THRESHOLD rejoins per session per window) evicts
// the session from the allowlist so it must re-authenticate — preventing a
// broken client from hammering the dispatch core.

/** Max rejoins a single session may attempt per REJOIN_WINDOW_MS before eviction. */
export const REJOIN_FLOOD_THRESHOLD = 5
/** Rolling window for rejoin flood detection (ms). */
export const REJOIN_WINDOW_MS = 60_000
/** How long an evicted session must wait before it may rejoin again (ms). */
export const REJOIN_BACKOFF_MS = 30_000

interface RejoinEntry {
  admittedAt: number
  rejoins: number
  windowStart: number
  evictedUntil: number
}

export class RejoinAllowlist {
  private sessions = new Map<string, RejoinEntry>()

  /** Add a session to the allowlist (called after WS auth handshake succeeds). */
  admit(sessionId: string): void {
    const existing = this.sessions.get(sessionId)
    this.sessions.set(sessionId, {
      admittedAt: existing?.admittedAt ?? Date.now(),
      rejoins: 0,
      windowStart: Date.now(),
      evictedUntil: 0,
    })
  }

  /** Remove a session (called on clean disconnect or session expiry). */
  evict(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /**
   * Check whether a rejoin is permitted for the given session.
   * Returns `{ allowed: true }` or `{ allowed: false, retryAfterMs }`.
   * Side-effect: increments the rejoin counter; evicts on flood.
   */
  checkRejoin(sessionId: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const entry = this.sessions.get(sessionId)
    const now = Date.now()

    if (!entry) {
      // Unknown session — not in allowlist; must authenticate first.
      return { allowed: false, retryAfterMs: 0 }
    }

    if (now < entry.evictedUntil) {
      return { allowed: false, retryAfterMs: entry.evictedUntil - now }
    }

    // Roll the flood-detection window.
    if (now - entry.windowStart > REJOIN_WINDOW_MS) {
      entry.rejoins = 0
      entry.windowStart = now
    }

    entry.rejoins++

    if (entry.rejoins > REJOIN_FLOOD_THRESHOLD) {
      entry.evictedUntil = now + REJOIN_BACKOFF_MS
      entry.rejoins = 0
      entry.windowStart = now
      return { allowed: false, retryAfterMs: REJOIN_BACKOFF_MS }
    }

    return { allowed: true }
  }

  /** Current allowlist size (for diagnostics). */
  size(): number {
    return this.sessions.size
  }

  /** Purge entries that have been fully idle for longer than `ttlMs`. */
  gc(ttlMs = 10 * 60_000, now = Date.now()): void {
    for (const [id, entry] of this.sessions) {
      if (now - entry.admittedAt > ttlMs && now >= entry.evictedUntil) {
        this.sessions.delete(id)
      }
    }
  }
}

/** Process-level singleton — import and call `.admit(sessionId)` on WS auth. */
export const rejoinAllowlist = new RejoinAllowlist()

/**
 * Express rate-limiter for POST /api/dispatch/rejoin.
 * Tighter than the general budget (5 req/min/IP) so a reconnect storm cannot
 * exhaust the global limit for other clients on the same egress IP.
 * Mount this BEFORE the general limiter on the rejoin route.
 */
export const rejoinLimiter = createLimiter({
  windowMs: REJOIN_WINDOW_MS,
  max: REJOIN_FLOOD_THRESHOLD,
  message: 'Rejoin rate limit exceeded — wait before reconnecting.',
})

export const rateLimiters = {
  general: generalLimiter,
  prover: proverLimiter,
  telemetry: telemetryLimiter,
  auth: authLimiter,
  data: dataLimiter,
  rejoin: rejoinLimiter,
}

export default createLimiter
