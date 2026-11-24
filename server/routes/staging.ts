/**
 * POST /api/staging/check-in — authoritative check for a signed staging payload (#940).
 *
 * Body: { payload: string | object } where payload is the signed staging record.
 * Responses: 201 accepted · 200 duplicate · 409 revoked · 422 forged/stale/malformed
 * · 503 unconfigured (no STAGING_SECRET_HEX, so the gate fails closed).
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { createStagingGateway, type StagingGateway } from '../lib/stagingCheckIn.ts'

export interface StagingRouterOptions {
  gateway?: StagingGateway
  secretHex?: string
  revokedStagingIds?: string[]
}

export function createStagingRouter(options: StagingRouterOptions = {}): Router {
  const gateway =
    options.gateway ??
    createStagingGateway({ secretHex: options.secretHex, revokedStagingIds: options.revokedStagingIds ?? [] })
  const router = Router()

  router.post('/check-in', (req: Request, res: Response) => {
    const payload = (req.body as { payload?: unknown } | undefined)?.payload
    const outcome = gateway.checkIn(payload)
    res.status(outcome.status).json(outcome.body)
  })

  return router
}

/** Reads STAGING_SECRET_HEX and a comma-separated STAGING_REVOKED_IDS list. */
export function stagingRouterFromEnv(env: NodeJS.ProcessEnv = process.env): Router {
  const revoked = (env.STAGING_REVOKED_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  return createStagingRouter({ secretHex: env.STAGING_SECRET_HEX || undefined, revokedStagingIds: revoked })
}
