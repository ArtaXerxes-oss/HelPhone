/**
 * Server-side dispatch queue priority management.
 * Prevents urgent requests from starving under stale update loads.
 * Integrates with dispatch.ts envelope relay.
 */

import type { Request, Response, NextFunction } from 'express'
import { toAdr020Tier, toQueuePriority, type Adr020Tier, type DispatchPriority } from '../../src/lib/dispatchQueue.ts'

export interface PriorityContext {
  requestId: string
  priority: DispatchPriority
  tier: Adr020Tier
  timestamp: number
  isUpdate: boolean
}

const PRIORITY_DETECTION_PATTERNS = {
  critical: /escalat|urgent|danger|imminent|critical|medical|emergency/i,
  high: /need|request|help|serious|accept|assign|ack/i,
  low: /telemetry|metrics|heartbeat|ice-metric/i,
}

/**
 * Detect priority from message semantics and optional X-Priority header.
 * Enforces the ADR-020 no-identity rule: priority is based on message type,
 * never on wallet identity, responder role, or reputation score.
 */
export function detectPriority(req: Request): DispatchPriority {
  const header = req.headers['x-priority']?.toString().trim().toLowerCase()
  if (header === 'critical' || header === 'p0' || header === 'high' || header === 'p1' || header === 'normal' || header === 'p2' || header === 'low' || header === 'p3') {
    return toQueuePriority(header)
  }

  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {})
  if (PRIORITY_DETECTION_PATTERNS.critical.test(body)) return 'critical'
  if (PRIORITY_DETECTION_PATTERNS.high.test(body)) return 'high'
  if (PRIORITY_DETECTION_PATTERNS.low.test(req.path || '') || PRIORITY_DETECTION_PATTERNS.low.test(body)) return 'low'

  return 'normal'
}

/**
 * Determine if a request is a status update (vs. new dispatch).
 * Updates are deprioritized if critical requests are pending.
 */
export function isStaleUpdate(req: Request): boolean {
  const method = req.method.toUpperCase()
  if (method !== 'POST' && method !== 'PUT') return false

  const body = req.body || {}
  const isStatusChange = 'status' in body || 'state' in body || 'update' in body
  const age = Date.now() - ((body.timestamp as number) ?? 0)

  return isStatusChange && age > 5_000
}

/**
 * Middleware attaching priority context to requests.
 */
export function createDispatchPriorityMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    const priority = detectPriority(req)
    const tier = toAdr020Tier(priority)
    const isUpdate = isStaleUpdate(req)

    ;(req as any).priorityContext = {
      requestId: req.path,
      priority,
      tier,
      timestamp: Date.now(),
      isUpdate,
    } as PriorityContext

    next()
  }
}

/**
 * Attach priority context to request object for downstream middleware.
 */
declare global {
  namespace Express {
    interface Request {
      priorityContext?: PriorityContext
    }
  }
}
