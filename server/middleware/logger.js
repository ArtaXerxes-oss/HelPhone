/**
 * Logger middleware — JS runtime (mirrors logger.ts)
 */
import { getPool } from '../db/connection.js';

export function logger(opts = {}) {
  const slowThreshold = opts.slowThresholdMs ?? 1000;
  return (req, res, next) => {
    const start = Date.now();
    const { method, originalUrl } = req;
    const traceparent = req.get('traceparent');
    const traceId = typeof traceparent === 'string' && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i.test(traceparent)
      ? traceparent.split('-')[1].toLowerCase()
      : null;
    const originalEnd = res.end.bind(res);
    let logged = false;
    const doLog = () => {
      if (logged) return;
      logged = true;
      const duration = Date.now() - start;
      const status = res.statusCode;
      const len = res.getHeader('content-length') || '-';
      let pool = null;
      try {
        if (opts.includePoolStats || req.query.pool === '1' || process.env.DEBUG_POOL) pool = getPool().getStats();
      } catch {}
      const entry = { ts: new Date().toISOString(), traceId, method, url: originalUrl, status, durationMs: duration, bytes: len, ip: req.ip, ua: req.get('user-agent')?.slice(0, 120) };
      if (pool) entry.pool = pool;
      if (duration > slowThreshold) entry.slow = true;
      const line = JSON.stringify(entry);
      if (status >= 500) console.error(line); else if (status >= 400) console.warn(line); else console.log(line);
    };
    res.on('finish', doLog);
    res.on('close', doLog);
    res.end = (...args) => {
      const result = originalEnd(...args);
      setImmediate(doLog);
      return result;
    };
    next();
  };
}
export function poolMonitorMiddleware(_req, res, next) {
  try { res.locals.poolStats = getPool().getStats(); } catch {}
  next();
}
export default logger;
