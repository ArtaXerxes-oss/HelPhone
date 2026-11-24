import type { Request, Response, NextFunction } from 'express'

/**
 * UV-tier gate for sensitive endpoints (#924, ADR-026).
 *
 * A passkey session carries `uv` in its claims (ISP-059 / #729). Sensitive
 * actions require `uv === true`. The check fails closed: a missing user, a
 * legacy token, or a limited (`uv=false`) session is refused with
 * `403 uv_tier_insufficient`. A user upgrades by completing a UV-verified
 * passkey login, which mints a new session. No re-registration is needed.
 */

export const UV_TIER_INSUFFICIENT = 'uv_tier_insufficient'

/** True only when the authenticated user carries an explicit uv=true claim. */
export function hasUvTier(user: unknown): boolean {
  return typeof user === 'object' && user !== null && (user as { uv?: unknown }).uv === true
}

/**
 * Express gate. Mount after `authMiddleware`, which populates
 * `req.authenticatedUser`.
 */
export function requireUvTier(req: Request, res: Response, next: NextFunction): void {
  if (!hasUvTier((req as Request & { authenticatedUser?: unknown }).authenticatedUser)) {
    res.status(403).json({ success: false, error: UV_TIER_INSUFFICIENT })
    return
  }
  next()
}
