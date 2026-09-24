/**
 * server/middleware/cors.ts — Stateful CORS Origin Validation & Preflight Caching
 *
 * - Dynamic origin whitelisting via env-configured domain regex patterns
 * - Preflight response caching with Access-Control-Max-Age: 86400 (24h)
 * - Rejects unauthorized origins (no ACAO header; OPTIONS -> 403)
 * - Validates ALLOWED_ORIGINS at startup (regex compile)
 */

import type { Request, Response, NextFunction } from 'express'
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

export const ALLOWED_METHODS = ['GET', 'POST', 'OPTIONS'] as const
export const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Requested-With',
  'Accept',
] as const

/**
 * Test whether a given Origin header value matches any allowed regex.
 * - No Origin header -> false (same-origin / curl; not CORS)
 * - Empty/null -> false
 */
export function isOriginAllowed(origin: string | undefined | null, regexes: RegExp[]): boolean {
  if (!origin || typeof origin !== 'string') return false
  const trimmed = origin.trim()
  if (!trimmed) return false
  return regexes.some((re) => re.test(trimmed))
}

/**
 * Build an array of RegExps from a raw comma-separated env string or array.
 * Public helper for tests and server/env integration.
 */
export function buildOriginRegexes(input: string | string[]): RegExp[] {
  const patterns: string[] =
    typeof input === 'string' ? parseAllowedOrigins(input) : input
  return patterns.map(compileOriginPattern).filter(Boolean) as RegExp[]
}

/**
 * Create the stateful CORS middleware.
 * - Caches regexes at construction so per-request work is O(#patterns) re.test
 * - Sets Vary: Origin so caches correctly partition by origin
 */
export interface CorsOptions {
  allowedOrigins?: string // raw env string or comma-separated list
  allowedPatterns?: string[] // explicit pattern list (overrides allowedOrigins)
  maxAge?: number
  allowedMethods?: string[]
  allowedHeaders?: string[]
}

export function createCorsMiddleware(opts: CorsOptions = {}) {
  const patterns = opts.allowedPatterns
    ? opts.allowedPatterns
    : opts.allowedOrigins
      ? parseAllowedOrigins(opts.allowedOrigins)
      : getAllowedOriginPatterns()

  const regexes = patterns.map(compileOriginPattern).filter(Boolean) as RegExp[]
  const maxAge = opts.maxAge ?? MAX_AGE
  const methods = opts.allowedMethods ?? [...ALLOWED_METHODS]
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
      // For OPTIONS without Origin (non-CORS preflight), just continue to allow 204 handling?
      // We still want to handle OPTIONS preflight explicitly if it's CORS; without Origin we treat as normal.
      if (req.method === 'OPTIONS') {
        // Provide generic CORS headers for non-origin OPTIONS to avoid hanging
        // but do not echo Origin
        res.setHeader('Access-Control-Allow-Methods', methods.join(', '))
        res.setHeader('Access-Control-Allow-Headers', headers.join(', '))
        res.setHeader('Access-Control-Max-Age', String(maxAge))
        return res.status(204).end()
      }
      return next()
    }

    const allowed = isOriginAllowed(origin, regexes)

    if (!allowed) {
      // Unauthorized origin: do not set ACAO.
      // For preflight OPTIONS, explicitly reject so browser cannot cache a permissive response.
      if (req.method === 'OPTIONS') {
        // Do NOT set ACAO; tell caches not to store this denial via Max-Age omission
        // Return 403 with JSON to make automated security tests deterministic
        // (spec says "unauthorized origins are rejected")
        res.setHeader('Access-Control-Allow-Methods', methods.join(', '))
        // Intentionally omit Access-Control-Allow-Origin and Access-Control-Max-Age
        return res.status(403).json({
          success: false,
          error: 'Origin not allowed by CORS policy',
        })
      }
      // For simple CORS requests, proceed without CORS headers – browser will block response
      return next()
    }

    // Allowed origin – set CORS headers
    res.setHeader('Access-Control-Allow-Origin', origin)
    // Credentials are not needed for ZK prover (no cookies), keep false to avoid extra complexity
    // If you need credentials, set Access-Control-Allow-Credentials: true and mirror origin
    res.setHeader('Access-Control-Allow-Methods', methods.join(', '))
    res.setHeader('Access-Control-Allow-Headers', headers.join(', '))
    // Only set Max-Age on preflight responses (per spec, but also harmless on simple requests)
    // We set it always when allowed to aid caching; spec says preflight caching
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Max-Age', String(maxAge))
      // Successful preflight -> 204 No Content (fetch spec)
      return res.status(204).end()
    }

    // For non-OPTIONS allowed requests, still set Max-Age is not needed but we set ACAO
    // Set Max-Age only on OPTIONS per spec; but some browsers cache via header on preflight only
    // Keep it simple: do not set Max-Age on simple requests
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
