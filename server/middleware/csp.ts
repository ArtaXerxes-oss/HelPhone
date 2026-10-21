import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Content-Security-Policy + cross-origin isolation headers.
 *
 * Ordering contract: this must be the first middleware in the stack, before
 * compression/logger/body parsing, so every response — including 4xx/5xx,
 * 429, and 413 — carries the same policy. The nonce is per-response and is
 * exposed on res.locals.cspNonce for server-rendered templates.
 */

export interface CspOptions {
  dev?: boolean;
  reportUri?: string;
  nonceBytes?: number;
  extraConnectSrc?: string[];
  extraScriptSrc?: string[];
  extraImgSrc?: string[];
}

export function createNonce(bytes = 16): string {
  return randomBytes(bytes).toString('base64');
}

export function buildCsp(options: CspOptions = {}): string {
  const dev = options.dev ?? process.env.NODE_ENV !== 'production';
  const nonce = options.nonce ?? createNonce(options.nonceBytes);
  const connect = [
    "'self'",
    'https://*.mapbox.com',
    'https://*.tiles.mapbox.com',
    'https://soroban-testnet.stellar.org',
    'https://horizon-testnet.stellar.org',
    'wss://*.helphone.com',
    ...(options.extraConnectSrc ?? []),
  ];
  if (dev) {
    connect.push('ws://localhost:*', 'http://localhost:*', 'ws://127.0.0.1:*', 'http://127.0.0.1:*');
  }

  const script = [
    "'self'",
    `'nonce-${nonce}'`,
    // Vite's dev client uses inline bootstrap code; production is strict.
    ...(dev ? ["'unsafe-eval'", "'unsafe-inline'"] : ["'strict-dynamic'"]),
    ...(options.extraScriptSrc ?? []),
  ];

  const img = [
    "'self'",
    'data:',
    'blob:',
    'https://*.mapbox.com',
    'https://*.tiles.mapbox.com',
    ...(options.extraImgSrc ?? []),
  ];

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': script,
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': img,
    'font-src': ["'self'", 'data:'],
    'media-src': ["'self'", 'blob:'],
    'connect-src': connect,
    'worker-src': ["'self'", 'blob:'],
    'child-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'manifest-src': ["'self'"],
  };
  if (options.reportUri) directives['report-uri'] = [options.reportUri];

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

export interface CspMiddlewareOptions extends CspOptions {
  headerName?: string;
  reportOnly?: boolean;
}

/** Named `csp` so middleware-order tests can assert the stack explicitly. */
export function cspMiddleware(options: CspMiddlewareOptions = {}) {
  const headerName = options.headerName ?? 'Content-Security-Policy';
  return function csp(req: Request, res: Response, next: NextFunction) {
    const nonce = createNonce(options.nonceBytes);
    res.locals.cspNonce = nonce;
    res.setHeader(headerName, buildCsp({ ...options, nonce }));
    // Cross-origin isolation is part of the same first-response contract;
    // server/index.ts also asserts these literals for the COEP spike test.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  };
}

export function securityHeaders() {
  return function securityHeadersMiddleware(_req: Request, res: Response, next: NextFunction) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    if (!res.hasHeader('Strict-Transport-Security') && process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

/** CSP violation sink; bounded and never reflects attacker-controlled bodies. */
export function cspReportHandler(req: Request, res: Response) {
  const report = req.body?.['csp-report'] ?? req.body ?? {};
  const blocked = String(report['blocked-uri'] ?? report.blockedURL ?? '').slice(0, 300);
  const directive = String(report['violated-directive'] ?? report.effectiveDirective ?? '').slice(0, 120);
  console.warn('[csp]', JSON.stringify({ blocked, directive, ua: req.get('user-agent')?.slice(0, 120) }));
  res.status(204).end();
}

export default cspMiddleware;
