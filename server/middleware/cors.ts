/**
 * server/middleware/cors.ts — Stateful CORS Origin Validation & Preflight Caching
 *
 * - Dynamic origin whitelisting via env-configured domain regex patterns
 * - Preflight response caching with Access-Control-Max-Age: 86400 (24h)
 * - Rejects unauthorized origins (no ACAO header; OPTIONS -> 403)
 * - Validates ALLOWED_ORIGINS at startup (regex compile)
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express'
import {
  CORS_MAX_AGE,
  getAllowedOriginRegexes,
  getAllowedOriginPatterns,
  compileOriginPattern,
  parseAllowedOrigins,
} from '../env.js'

export const MAX_AGE = CORS_MAX_AGE
export const DEFAULT_ALLOWED_ORIGINS = [
  'https://helphone.com',
  'https://staging.helphone.com',
]

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
]

export const ALLOWED_METHODS = ['GET', 'POST', 'OPTIONS'] as const
export const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Requested-With',
  'Accept',
] as const

/**
 * Test whether a given Origin header value matches any allowed regex or string rule.
 * - No Origin header -> false (same-origin / curl; not CORS)
 * - Empty/null -> false
 */
export function isOriginAllowed(
  origin: string | undefined | null,
  allowed: (RegExp | string)[]
): boolean {
  if (!origin || typeof origin !== 'string') return false
  const trimmed = origin.trim()
  if (!trimmed) return false

  return allowed.some((rule) => {
    if (rule instanceof RegExp) {
      return rule.test(trimmed)
    }
    if (rule === '*' || rule === trimmed) return true
    if (typeof rule === 'string' && rule.startsWith('*.')) {
      const suffix = rule.slice(1)
      return trimmed.endsWith(suffix) && trimmed.length > suffix.length
    }
    return false
  })
}

export function buildOriginRegexes(input: string | string[]): RegExp[] {
  const patterns: string[] =
    typeof input === 'string' ? parseAllowedOrigins(input) : input
  return patterns.map(compileOriginPattern).filter(Boolean) as RegExp[]
}

export interface CorsOptions {
  allowedOrigins?: string | string[]
  allowedPatterns?: string[]
  maxAge?: number
  maxAgeSeconds?: number
  allowedMethods?: string[]
  methods?: string[]
  allowedHeaders?: string[]
  exposedHeaders?: string[]
  credentials?: boolean
  dev?: boolean
  rejectUnknown?: boolean
}

export function resolveAllowedOrigins(options: CorsOptions = {}): string[] {
  const fromEnv = process.env.ALLOWED_ORIGINS
    ? parseAllowedOrigins(process.env.ALLOWED_ORIGINS)
    : []
  const dev = options.dev ?? process.env.NODE_ENV !== 'production'
  const explicit = Array.isArray(options.allowedOrigins)
    ? options.allowedOrigins
    : typeof options.allowedOrigins === 'string'
      ? parseAllowedOrigins(options.allowedOrigins)
      : []
  return [...DEFAULT_ALLOWED_ORIGINS, ...(dev ? DEFAULT_DEV_ORIGINS : []), ...explicit, ...fromEnv]
}

export function corsPreflightFallback(): RequestHandler {
  return (req, res, next) => {
    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  }
}

/**
 * Create the stateful CORS middleware.
 * - Caches regexes at construction so per-request work is O(#patterns) re.test
 * - Sets Vary: Origin so caches correctly partition by origin
 */
export function createCorsMiddleware(opts: CorsOptions = {}) {
  const patterns = opts.allowedPatterns
    ? opts.allowedPatterns
    : opts.allowedOrigins
      ? Array.isArray(opts.allowedOrigins)
        ? opts.allowedOrigins
        : parseAllowedOrigins(opts.allowedOrigins)
      : getAllowedOriginPatterns()

  const regexes = patterns.map(compileOriginPattern).filter(Boolean) as RegExp[]
  const maxAge = opts.maxAge ?? opts.maxAgeSeconds ?? MAX_AGE
  const methods = opts.allowedMethods ?? opts.methods ?? [...ALLOWED_METHODS]
  const headers = opts.allowedHeaders ?? [...ALLOWED_HEADERS]

  // Validate at construction – fail fast if env mis-configured
  if (regexes.length === 0 && patterns.length > 0) {
    console.warn('[cors] No valid origin patterns compiled; CORS will deny all origins')
  }

  function corsMiddleware(req: Request, res: Response, next: NextFunction) {
    const origin = req.headers.origin as string | undefined

    // Always set Vary so downstream caches partition correctly
    res.setHeader('Vary', 'Origin')

    // If no Origin header, this is not a CORS request – pass through
    if (!origin) {
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', methods.join(', '))
        res.setHeader('Access-Control-Allow-Headers', headers.join(', '))
        res.setHeader('Access-Control-Max-Age', String(maxAge))
        return res.status(204).end()
      }
      return next()
    }

    const allowed = isOriginAllowed(origin, regexes)

    if (!allowed) {
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', methods.join(', '))
        return res.status(403).json({
          success: false,
          error: 'Origin not allowed by CORS policy',
        })
      }
      if (opts.rejectUnknown) {
        return res.status(403).json({ error: 'cors_origin_denied', origin })
      }
      return next()
    }

    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', opts.credentials !== false ? 'true' : 'false')
    res.setHeader('Access-Control-Allow-Methods', methods.join(', '))
    res.setHeader('Access-Control-Allow-Headers', headers.join(', '))
    if (opts.exposedHeaders?.length) {
      res.setHeader('Access-Control-Expose-Headers', opts.exposedHeaders.join(', '))
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Max-Age', String(maxAge))
      return res.status(204).end()
    }

    return next()
  }

  // Expose helpers for testing / observability
  ;(corsMiddleware as any).isOriginAllowed = (origin: string) => isOriginAllowed(origin, regexes)
  ;(corsMiddleware as any).getPatterns = () => [...patterns]
  ;(corsMiddleware as any).getRegexes = () => [...regexes]
  ;(corsMiddleware as any).maxAge = maxAge

  return corsMiddleware
}

// Default instance using env at import time (suitable for server/index.ts)
export const corsMiddleware = createCorsMiddleware()

export default corsMiddleware
