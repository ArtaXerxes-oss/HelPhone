/**
 * server/middleware/csp.ts — Dynamic Content Security Policy nonce engine (#530)
 *
 * - A fresh cryptographic nonce for every HTTP response
 * - A strict policy: scripts and styles run only with that nonce (no
 *   'unsafe-inline'), connections only to an explicit origin allowlist
 * - HTML rendering that stamps the nonce onto every <script> / <style> tag
 *
 * A nonce is only safe if it is unguessable and never reused, so HTML that
 * carries one must never be cached: `createHtmlHandler` sends `no-store`.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { NextFunction, Request, RequestHandler, Response } from 'express'

/** Value Vite writes into built HTML (`html.cspNonce`); replaced per response. */
export const CSP_NONCE_PLACEHOLDER = '__CSP_NONCE__'

/** 128 bits, as recommended by the CSP spec (at least 128 bits of entropy). */
const NONCE_BYTES = 16

export const CSP_HEADER = 'Content-Security-Policy'
export const CSP_REPORT_ONLY_HEADER = 'Content-Security-Policy-Report-Only'

/**
 * Origins the app is known to talk to (Soroban RPC, Horizon, Mapbox, the API).
 * Anything else must be added deliberately through `CSP_CONNECT_SRC`.
 */
export const DEFAULT_CONNECT_SRC = [
  'https://soroban-testnet.stellar.org',
  'https://mainnet.sorobanrpc.com',
  'https://rpc-futurenet.stellar.org',
  'https://horizon-testnet.stellar.org',
  'https://horizon.stellar.org',
  'https://horizon-futurenet.stellar.org',
  'https://friendbot.stellar.org',
  'https://api.mapbox.com',
  'https://events.mapbox.com',
  'https://helphone.onrender.com',
] as const

export interface CspOptions {
  /** Extra `connect-src` origins on top of the defaults. */
  connectSrc?: readonly string[]
  /** Send as Content-Security-Policy-Report-Only instead of enforcing. */
  reportOnly?: boolean
  /** Where browsers should POST violation reports. */
  reportUri?: string
  /** Add `upgrade-insecure-requests` (leave off for plain-http local dev). */
  upgradeInsecure?: boolean
  dev?: boolean
  nonceBytes?: number
  nonce?: string
  extraConnectSrc?: string[]
  extraScriptSrc?: string[]
  extraImgSrc?: string[]
}

export interface CspMiddlewareOptions extends CspOptions {
  headerName?: string
}

export function generateNonce(bytes = NONCE_BYTES): string {
  return randomBytes(bytes).toString('base64')
}

export const createNonce = generateNonce

// scheme://host[:port], an optional leading `*.` wildcard label, nothing else.
// This is what keeps a value from smuggling `;` or `,` (a new directive or a
// header split) or a bare `*` / `https:` (allow-everything) into the header.
const ORIGIN_RE = /^(?:https?|wss?):\/\/(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/

export function isValidSource(value: string): boolean {
  return ORIGIN_RE.test(value)
}

/**
 * Parse a comma-separated origin list. Invalid entries are dropped and
 * reported through `onInvalid`, never silently widened into the policy.
 */
export function parseSourceList(
  raw: string | undefined,
  onInvalid: (entry: string) => void = () => {}
): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const part of raw.split(',')) {
    const entry = part.trim()
    if (!entry) continue
    if (isValidSource(entry)) out.push(entry)
    else onInvalid(entry)
  }
  return out
}

function isValidReportUri(uri: string): boolean {
  return /^(?:https?:\/\/[A-Za-z0-9.:-]+)?\/[A-Za-z0-9\-._~/%]*$/.test(uri)
}

/** Build the policy string for one response's nonce. */
export function buildCspHeader(nonce: string, opts: CspOptions = {}): string {
  const n = `'nonce-${nonce}'`
  const extra = [...(opts.connectSrc ?? []), ...(opts.extraConnectSrc ?? [])]
  const connect = [...new Set(["'self'", ...DEFAULT_CONNECT_SRC, ...extra])]

  const directives: string[][] = [
    ['default-src', "'none'"],
    // 'wasm-unsafe-eval' lets the Noir/Barretenberg WASM compile; it does not
    // permit eval() or inline script.
    ['script-src', "'self'", n, "'wasm-unsafe-eval'", ...(opts.extraScriptSrc ?? [])],
    ['style-src', "'self'", n, 'https://fonts.googleapis.com'],
    // Nonces cannot be applied to style="" attributes, and React/Mapbox set
    // them at runtime. Scope the relaxation to attributes only.
    ['style-src-attr', "'unsafe-inline'"],
    ['font-src', "'self'", 'https://fonts.gstatic.com', 'data:'],
    ['img-src', "'self'", 'data:', 'blob:', 'https://api.mapbox.com', 'https://*.tiles.mapbox.com', ...(opts.extraImgSrc ?? [])],
    ['media-src', "'self'"],
    ['connect-src', ...connect],
    ['worker-src', "'self'", 'blob:'],
    ['manifest-src', "'self'"],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
    ['frame-ancestors', "'none'"],
  ]
  if (opts.upgradeInsecure) directives.push(['upgrade-insecure-requests'])
  if (opts.reportUri && isValidReportUri(opts.reportUri)) {
    directives.push(['report-uri', opts.reportUri])
  }
  return directives.map((d) => d.join(' ')).join('; ')
}

export function buildCsp(options: CspOptions = {}): string {
  const nonce = options.nonce ?? generateNonce(options.nonceBytes)
  return buildCspHeader(nonce, options)
}

/**
 * Stamp `nonce` onto every <script> and <style> opening tag that lacks one,
 * and swap in the Vite placeholder. Idempotent.
 */
export function injectNonce(html: string, nonce: string): string {
  const stamped = html.replace(/<(script|style)\b([^>]*)>/gi, (tag, name: string, attrs: string) =>
    /\snonce\s*=/i.test(attrs) ? tag : `<${name} nonce="${nonce}"${attrs}>`
  )
  return stamped.split(CSP_NONCE_PLACEHOLDER).join(nonce)
}

/** Read CSP settings from the environment (validated; bad entries are warned about). */
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): CspOptions {
  return {
    connectSrc: parseSourceList(env.CSP_CONNECT_SRC, (entry) =>
      console.warn(`[csp] Ignoring invalid CSP_CONNECT_SRC entry: ${JSON.stringify(entry)}`)
    ),
    reportOnly: env.CSP_REPORT_ONLY === 'true',
    reportUri: env.CSP_REPORT_URI || undefined,
    upgradeInsecure: env.NODE_ENV === 'production',
  }
}

/**
 * Generates a nonce per request, exposes it as `res.locals.cspNonce`, and
 * sets the policy header for that response.
 */
export function createCspMiddleware(opts: CspOptions = optionsFromEnv()): RequestHandler {
  return function cspMiddleware(_req: Request, res: Response, next: NextFunction) {
    const nonce = generateNonce(opts.nonceBytes)
    const header = opts.reportOnly ? CSP_REPORT_ONLY_HEADER : CSP_HEADER
    res.locals.cspNonce = nonce
    res.setHeader(header, buildCspHeader(nonce, opts))
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    next()
  }
}

export function cspMiddleware(options: CspMiddlewareOptions = {}) {
  return function csp(req: Request, res: Response, next: NextFunction) {
    const header = options.headerName ?? (options.reportOnly ? CSP_REPORT_ONLY_HEADER : CSP_HEADER)
    const nonce = generateNonce(options.nonceBytes)
    res.locals.cspNonce = nonce
    res.setHeader(header, buildCspHeader(nonce, options))
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    next()
  }
}

export function securityHeaders() {
  return function securityHeadersMiddleware(_req: Request, res: Response, next: NextFunction) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)')
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none')
    res.setHeader('X-DNS-Prefetch-Control', 'off')
    if (!res.hasHeader('Strict-Transport-Security') && process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    next()
  }
}

export function cspReportHandler(req: Request, res: Response) {
  const report = req.body?.['csp-report'] ?? req.body ?? {}
  const blocked = String(report['blocked-uri'] ?? report.blockedURI ?? 'unknown').slice(0, 256)
  const directive = String(report['violated-directive'] ?? report.directive ?? 'unknown').slice(0, 64)
  console.warn('[csp]', JSON.stringify({ blocked, directive, ua: req.get('user-agent')?.slice(0, 120) }))
  res.status(204).end()
}

export interface HtmlHandlerOptions {
  /** Path to the built index.html. */
  htmlPath: string
  /** Re-read the file on every request (dev). Default: read once and cache. */
  cache?: boolean
}

/**
 * Serves the SPA shell with this response's nonce injected. Falls through to
 * `next()` when the HTML has not been built, so an API-only deploy is unchanged.
 */
export function createHtmlHandler({ htmlPath, cache = true }: HtmlHandlerOptions): RequestHandler {
  let template: string | null = null
  return function htmlHandler(_req: Request, res: Response, next: NextFunction) {
    if (!existsSync(htmlPath)) return next()
    if (template === null || !cache) template = readFileSync(htmlPath, 'utf8')

    // The nonce comes from cspMiddleware so header and markup always agree.
    // Without it there is nothing safe to inject, so refuse rather than serve
    // scripts a strict policy would block.
    const nonce = res.locals.cspNonce as string | undefined
    if (!nonce) return next(new Error('cspMiddleware must run before the HTML handler'))

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    // A cached copy would replay a stale nonce against a fresh header.
    res.setHeader('Cache-Control', 'no-store')
    res.send(injectNonce(template, nonce))
  }
}

export default cspMiddleware
