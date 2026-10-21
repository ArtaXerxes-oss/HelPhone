import cors from 'cors';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Restricted CORS for the API.
 *
 * The previous server accepted any configured list but still answered unknown
 * origins with a 200 (only omitting Access-Control-Allow-Origin). This module
 * denies unknown origins explicitly and supports exact origins plus
 * `*.helphone.com` style wildcards. Requests with no Origin (curl, same-origin,
 * server-to-server) are allowed.
 */

export interface CorsOptions {
  allowedOrigins?: string[];
  credentials?: boolean;
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  maxAgeSeconds?: number;
  dev?: boolean;
  rejectUnknown?: boolean;
}

const DEFAULT_ORIGINS = [
  'https://helphone.com',
  'https://www.helphone.com',
  'https://staging.helphone.com',
];

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
];

export function resolveAllowedOrigins(options: CorsOptions = {}): string[] {
  const fromEnv = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean)
    : [];
  const dev = options.dev ?? process.env.NODE_ENV !== 'production';
  return [...DEFAULT_ORIGINS, ...(dev ? DEFAULT_DEV_ORIGINS : []), ...(options.allowedOrigins ?? []), ...fromEnv];
}

export function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return true; // non-browser / same-origin requests do not send Origin
  if (allowed.includes('*')) return true;
  return allowed.some((rule) => {
    if (rule === origin) return true;
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(1); // ".helphone.com"
      return origin.endsWith(suffix) && origin.length > suffix.length;
    }
    return false;
  });
}

/** Named `corsPolicy` so the ordering test can find it before compression. */
export function corsMiddleware(options: CorsOptions = {}) {
  const allowed = resolveAllowedOrigins(options);
  const handler = cors({
    origin(origin, callback) {
      callback(null, isOriginAllowed(origin, allowed));
    },
    credentials: options.credentials ?? true,
    methods: options.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: options.allowedHeaders ?? ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Viewer-Id'],
    exposedHeaders: options.exposedHeaders ?? ['Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-Telemetry-Backpressure'],
    maxAge: options.maxAgeSeconds ?? 600,
    optionsSuccessStatus: 204,
    preflightContinue: false,
  });

  return function corsPolicy(req: Request, res: Response, next: NextFunction) {
    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin, allowed) && (options.rejectUnknown ?? true)) {
      res.status(403).json({ error: 'cors_origin_denied', origin });
      return;
    }
    handler(req, res, next);
  };
}

export function corsPreflightFallback(): RequestHandler {
  return (req, res, next) => {
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

export default corsMiddleware;
