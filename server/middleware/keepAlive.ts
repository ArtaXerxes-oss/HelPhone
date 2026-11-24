/**
 * HTTP Keep-Alive Socket Pool Tuning + WS Reap Timing (#909)
 *
 * Node's defaults (keepAliveTimeout 5s) are shorter than the idle timeout of
 * the load balancers we sit behind (Render/Cloudflare ~60s), so the balancer
 * regularly reuses a socket the origin has just closed and the client sees a
 * spurious 502. Holding sockets open longer than the balancer does removes
 * that race and lets sequential REST calls and WebSocket upgrades reuse one
 * TCP connection instead of paying a handshake each time.
 *
 * - keepAliveTimeout 65s: must exceed the upstream balancer's 60s idle timeout
 * - headersTimeout 66s:   must exceed keepAliveTimeout or Node can reset a
 *                         reused socket while waiting for the next request line
 * - HTTP/2 is negotiated at the TLS edge; this tunes the HTTP/1.1 origin, and
 *   connection-specific headers are never emitted on an HTTP/2 request.
 *
 * WS reap timing (spike #719 §4):
 * Mobile browsers suspend background tabs after 30–60 s and stop sending WS
 * pings.  A 30 s reap timeout is too aggressive — it reaped live responders
 * whose phone screens had just turned off, forcing a rejoin on wake.  The
 * revised defaults give the client 90 s before the server declares the socket
 * dead (WS_REAP_IDLE_MS) and 150 s for a session that has been categorised as
 * likely mobile-background (WS_MOBILE_REAP_IDLE_MS).  Callers that know the
 * client is mobile can pass `mobile: true` to `resolveReapOptions`.
 *
 * A rejoin grace window (WS_REJOIN_GRACE_MS) keeps the dispatch claim alive
 * on the server for that many milliseconds after the socket is reaped.  Any
 * rejoin that arrives within the window re-attaches without a duplicate-claim
 * race.  After the window the claim is released and the responder must compete
 * normally.
 */

import type { Server } from 'http';
import type { Request, Response, NextFunction } from 'express';

export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HEADERS_TIMEOUT_MS = 66_000;

// ── WS reap timing ─────────────────────────────────────────────────────────

/** Idle timeout before the server reaps a foreground WS connection (ms). */
export const WS_REAP_IDLE_MS = 90_000
/** Idle timeout for a connection classified as mobile-background (ms). */
export const WS_MOBILE_REAP_IDLE_MS = 150_000
/**
 * After a socket is reaped the dispatch claim stays reserved for this many ms.
 * A rejoin arriving within this window re-attaches without a duplicate-claim race.
 */
export const WS_REJOIN_GRACE_MS = 20_000

export interface ReapOptions {
  /** True when the client UA or last ping suggests a mobile background tab. */
  mobile?: boolean
  /** Override the foreground idle timeout (ms). */
  reapIdleMs?: number
  /** Override the mobile-background idle timeout (ms). */
  mobileReapIdleMs?: number
  /** Override the rejoin grace window (ms). */
  rejoinGraceMs?: number
}

export interface ResolvedReapOptions {
  reapIdleMs: number
  mobileReapIdleMs: number
  rejoinGraceMs: number
  /** Effective idle timeout to apply — mobile value when `mobile` is true. */
  effectiveIdleMs: number
}

/** Resolve WS reap values from options, then env, then the defaults above. */
export function resolveReapOptions(
  options: ReapOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedReapOptions {
  function envMs(key: string, fallback: number): number {
    const raw = env[key]
    if (!raw) return fallback
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : fallback
  }

  const reapIdleMs = options.reapIdleMs ?? envMs('WS_REAP_IDLE_MS', WS_REAP_IDLE_MS)
  const mobileReapIdleMs =
    options.mobileReapIdleMs ?? envMs('WS_MOBILE_REAP_IDLE_MS', WS_MOBILE_REAP_IDLE_MS)
  const rejoinGraceMs = options.rejoinGraceMs ?? envMs('WS_REJOIN_GRACE_MS', WS_REJOIN_GRACE_MS)
  const effectiveIdleMs = options.mobile ? mobileReapIdleMs : reapIdleMs

  return { reapIdleMs, mobileReapIdleMs, rejoinGraceMs, effectiveIdleMs }
}

export interface KeepAliveOptions {
  keepAliveTimeout?: number;
  headersTimeout?: number;
  /** Requests served per socket before Node closes it; 0 = unlimited. */
  maxRequestsPerSocket?: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Resolve tuning values from options, then env, then the defaults above. */
export function resolveKeepAliveOptions(
  options: KeepAliveOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Required<KeepAliveOptions> {
  const keepAliveTimeout =
    options.keepAliveTimeout ?? positiveInt(env.KEEP_ALIVE_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS);
  let headersTimeout =
    options.headersTimeout ?? positiveInt(env.HEADERS_TIMEOUT_MS, HEADERS_TIMEOUT_MS);
  // headersTimeout <= keepAliveTimeout reintroduces the reset race; keep it above.
  if (headersTimeout <= keepAliveTimeout) headersTimeout = keepAliveTimeout + 1_000;
  const maxRequestsPerSocket =
    options.maxRequestsPerSocket ?? nonNegativeInt(env.MAX_REQUESTS_PER_SOCKET, 0);
  return { keepAliveTimeout, headersTimeout, maxRequestsPerSocket };
}

/** Apply the tuning to a listening or not-yet-listening http.Server. */
export function applyKeepAliveTuning(
  server: Server,
  options: KeepAliveOptions = {},
): Required<KeepAliveOptions> {
  const resolved = resolveKeepAliveOptions(options);
  server.keepAliveTimeout = resolved.keepAliveTimeout;
  server.headersTimeout = resolved.headersTimeout;
  server.maxRequestsPerSocket = resolved.maxRequestsPerSocket;
  return resolved;
}

/**
 * Advertise the keep-alive window to clients on HTTP/1.x responses. Skipped for
 * HTTP/2, where Connection/Keep-Alive headers are forbidden.
 */
export function keepAliveMiddleware(options: KeepAliveOptions = {}) {
  const { keepAliveTimeout } = resolveKeepAliveOptions(options);
  const seconds = Math.floor(keepAliveTimeout / 1000);
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.httpVersionMajor < 2) {
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Keep-Alive', `timeout=${seconds}`);
    }
    next();
  };
}
