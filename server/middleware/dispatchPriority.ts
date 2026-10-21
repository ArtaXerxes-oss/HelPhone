/**
 * Server-side dispatch queue priority management.
 * Prevents urgent requests from starving under stale update loads.
 * Integrates with dispatch.ts envelope relay.
 */

import type { Request, Response, NextFunction } from 'express'

export interface PriorityContext {
  requestId: string
  priority: 'critical' | 'high' | 'normal' | 'low'
  timestamp: number
  isUpdate: boolean
}

const PRIORITY_DETECTION_PATTERNS = {
  critical: /escalat|urgent|danger|imminent|critical/i,
  high: /need|request|help|serious/i,
}

/**
 * Detect priority from request metadata.
 * Clients can optionally hint via X-Priority header; responders are always critical.
 */
export function detectPriority(req: Request): 'critical' | 'high' | 'normal' | 'low' {
  const header = req.headers['x-priority']?.toString().toLowerCase()
  if (header === 'critical') return 'critical'
  if (header === 'high') return 'high'

  const contentType = req.headers['content-type']?.toString() || ''
  if (contentType.includes('responder')) return 'critical'

  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {})
  if (PRIORITY_DETECTION_PATTERNS.critical.test(body)) return 'critical'
  if (PRIORITY_DETECTION_PATTERNS.high.test(body)) return 'high'

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
  return (req: Request, res: Response, next: NextFunction) => {
    const priority = detectPriority(req)
    const isUpdate = isStaleUpdate(req)

    ;(req as any).priorityContext = {
      requestId: req.path,
      priority,
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
