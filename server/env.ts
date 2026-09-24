/**
 * server/env.ts — Centralized environment validation for HelPhone prover
 *
 * Validates CORS origin patterns (regex based) and exposes helpers for
 * middleware. Keeps server/index.ts lean and makes env errors fail fast
 * instead of silently serving an open CORS policy.
 */

export const CORS_MAX_AGE = 86400 // 24 hours – preflight cache

const DEFAULT_ALLOWED_ORIGINS = [
  'https://helphone.com',
  'https://staging.helphone.com',
]

/**
 * Escape a plain origin string into an anchored regex.
 * e.g. https://helphone.com -> /^https:\/\/helphone\.com$/
 */
export function escapeOriginPattern(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile a single ALLOWED_ORIGINS entry into a RegExp.
 *
 * Entries are treated as:
 *  - raw regex if they contain `.*`, `\` or start with `^` (explicit regex)
 *  - otherwise exact origin (escaped) plus optional wildcard handling:
 *    `https://*.helphone.com` -> `^https:\/\/.*\.helphone\.com$`
 */
export function compileOriginPattern(raw: string): RegExp | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Explicit regex: contains \., .*, or anchored ^
  const isExplicitRegex = /\\|\.\*|^\^|\$$/.test(trimmed) || trimmed.startsWith('^')

  let source: string
  if (isExplicitRegex) {
    source = trimmed
    // Ensure anchored; allow user to omit ^$
    if (!source.startsWith('^')) source = '^' + source
    if (!source.endsWith('$')) source = source + '$'
  } else if (trimmed.includes('*')) {
    // Wildcard form: https://*.helphone.com
    const escaped = trimmed.split('*').map(escapeOriginPattern).join('.*')
    source = `^${escaped}$`
  } else {
    // Exact origin
    source = `^${escapeOriginPattern(trimmed)}$`
  }

  try {
    return new RegExp(source)
  } catch {
    // Invalid regex – fall back to exact escaped
    try {
      return new RegExp(`^${escapeOriginPattern(trimmed)}$`)
    } catch {
      return null
    }
  }
}

export function parseAllowedOrigins(raw?: string): string[] {
  if (!raw || !raw.trim()) return [...DEFAULT_ALLOWED_ORIGINS]
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function getAllowedOriginPatterns(): string[] {
  const raw = process.env.ALLOWED_ORIGINS
  return parseAllowedOrigins(raw)
}

export function getAllowedOriginRegexes(): RegExp[] {
  const patterns = getAllowedOriginPatterns()
  return patterns.map(compileOriginPattern).filter(Boolean) as RegExp[]
}

/**
 * Validate that all configured origins compile to valid regexes.
 * Throws on hard mis-configuration so deployment fails fast.
 */
export function validateCorsEnv(): { patterns: string[]; regexes: RegExp[] } {
  const patterns = getAllowedOriginPatterns()
  const regexes: RegExp[] = []
  const invalid: string[] = []
  for (const p of patterns) {
    const re = compileOriginPattern(p)
    if (!re) invalid.push(p)
    else regexes.push(re)
  }
  if (invalid.length) {
    throw new Error(`Invalid ALLOWED_ORIGINS entries: ${invalid.join(', ')}`)
  }
  return { patterns, regexes }
}

export function getCorsConfig() {
  return {
    maxAge: CORS_MAX_AGE,
    allowedOrigins: getAllowedOriginPatterns(),
    allowedRegexes: getAllowedOriginRegexes(),
    allowedMethods: ['GET', 'POST', 'OPTIONS'] as const,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'] as const,
  }
}
