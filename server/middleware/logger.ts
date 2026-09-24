import morgan from 'morgan'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { getPool } from '../db/connection.js'

/**
 * HTTP request logger middleware (upstream).
 *
 * Uses 'dev' format in development (coloured, concise) and 'combined'
 * (Apache Combined Log Format) in production so logs are structured
 * for ingestion by log aggregators.
 */
export const requestLogger: RequestHandler = morgan(
  process.env.NODE_ENV === 'production' ? 'combined' : 'dev',
)

/**
 * Logger middleware — structured JSON logging + pool metrics (performance hardening).
 *
 * - Logs method, url, status, duration, content-length
 * - Optionally includes db pool stats on each request (when ?pool=1 or DEBUG_POOL)
 * - Health endpoint at GET /health or /zk/health now exposes pool stats
 */

export interface LoggerOptions {
  includePoolStats?: boolean;
  slowThresholdMs?: number;
}

export function logger(opts: LoggerOptions = {}) {
  const slowThreshold = opts.slowThresholdMs ?? 1000;
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    const { method, originalUrl } = req;

    // Capture end to log
    const originalEnd = res.end.bind(res) as typeof res.end;
    let logged = false;
    const doLog = () => {
      if (logged) return;
      logged = true;
      const duration = Date.now() - start;
      const status = res.statusCode;
      const len = res.getHeader('content-length') || '-';
      const pool = opts.includePoolStats || req.query.pool === '1' || process.env.DEBUG_POOL
        ? (() => { try { return getPool().getStats(); } catch { return null; } })()
        : null;

      const entry: Record<string, unknown> = {
        ts: new Date().toISOString(),
        method,
        url: originalUrl,
        status,
        durationMs: duration,
        bytes: len,
        ip: req.ip,
        ua: req.get('user-agent')?.slice(0, 120),
      };
      if (pool) entry.pool = pool;
      if (duration > slowThreshold) entry.slow = true;

      const line = JSON.stringify(entry);
      if (status >= 500) console.error(line);
      else if (status >= 400) console.warn(line);
      else console.log(line);
    };

    res.on('finish', doLog);
    res.on('close', doLog);

    // Also monkey-patch end as belt-and-suspenders for Node <18 edge-cases
    (res as unknown as { end: typeof res.end }).end = ((...args: Parameters<typeof res.end>) => {
      const result = originalEnd(...(args as never[]));
      // finish will fire; but if not, log here
      setImmediate(doLog);
      return result;
    }) as typeof res.end;

    next();
  };
}

export function poolMonitorMiddleware(_req: Request, res: Response, next: NextFunction) {
  // Attach pool stats to res.locals for downstream handlers to optionally expose
  try {
    (res.locals as Record<string, unknown>).poolStats = getPool().getStats();
  } catch {}
  next();
}

export default logger;
