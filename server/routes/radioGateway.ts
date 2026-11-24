/**
 * POST /api/radio/relay — fragments relayed by a gateway station (#939).
 *
 * The feature flag is an environment switch: HELPHONE_RADIO_GATEWAY=off turns
 * the gateway off (503) without a deploy. Any other value, or no value, leaves
 * it on.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { z } from 'zod'
import type { DomainStore } from '../lib/domainStore.ts'
import { createRadioGateway, type RadioGateway } from '../lib/radioGateway.ts'

export function radioGatewayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HELPHONE_RADIO_GATEWAY !== 'off'
}

const relaySchema = z
  .object({
    gatewayId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    band: z.enum(['ham', 'licensed']),
    msgId: z.number().int().min(0).max(0xffffffff),
    fragIdx: z.number().int().min(0).max(254),
    fragCount: z.number().int().min(1).max(255),
    chunkB64: z.string().min(1).max(200),
  })
  .refine((body) => body.fragIdx < body.fragCount, {
    message: 'fragIdx must be less than fragCount',
    path: ['fragIdx'],
  })

export interface RadioGatewayRouterOptions {
  store: DomainStore
  enabled?: () => boolean
  gateway?: RadioGateway
}

export function createRadioGatewayRouter(options: RadioGatewayRouterOptions): Router {
  const gateway = options.gateway ?? createRadioGateway({ store: options.store })
  const isEnabled = options.enabled ?? (() => radioGatewayEnabled())
  const router = Router()

  router.post('/relay', (req: Request, res: Response) => {
    if (!isEnabled()) {
      res.status(503).json({ success: false, error: 'Radio gateway is disabled.' })
      return
    }
    const parsed = relaySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(422).json({
        error: 'validation_failed',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || 'body',
          message: issue.message,
        })),
      })
      return
    }
    const outcome = gateway.relay(parsed.data)
    res.status(outcome.status).json(outcome.body)
  })

  return router
}
