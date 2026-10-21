import type { NextFunction, Request, Response } from 'express';

/**
 * HTTP/2 server-push / preload filter.
 *
 * Push is easy to get dangerously wrong: pushing a response that carries the
 * requester's cookies or an Authorization header leaks credentials into the
 * push cache. This module refuses to push cross-origin URLs, API routes,
 * non-cacheable assets, or any request with cookies/authorization. It pushes
 * at most five same-origin static assets, and always falls back to Link
 * preload headers when push is unavailable.
 */

export interface PushOptions {
  maxAssets?: number;
  assets?: string[] | ((req: Request) => string[]);
  enablePush?: boolean;
  publicOrigin?: string;
}

const PUSHABLE_RE = /\.(?:css|js|mjs|woff2?|ttf|png|jpe?g|webp|avif|svg|ico)(?:\?.*)?$/i;

export function isSameOrigin(url: string, origin = 'https://helphone.com'): boolean {
  try {
    return new URL(url, origin).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

export function isPushableAsset(url: string, origin?: string): boolean {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
  if (url.startsWith('/api/') || url.startsWith('/graphql') || url.startsWith('/metrics')) return false;
  if (!PUSHABLE_RE.test(url.split('?')[0])) return false;
  return isSameOrigin(url, origin);
}

export function selectPushAssets(
  candidates: string[],
  options: { maxAssets?: number; origin?: string } = {},
): string[] {
  const max = Math.max(0, Math.min(20, options.maxAssets ?? 5));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!isPushableAsset(candidate, options.origin)) continue;
    const key = candidate.split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= max) break;
  }
  return out;
}

/** Credential-bearing requests never get push hints. */
export function canPushRequest(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.headers.cookie || req.headers.authorization) return false;
  if (String(req.headers['cache-control'] || '').includes('no-cache')) return false;
  if (req.headers['service-worker']) return false;
  return true;
}

/** Strip credentials from headers before they reach a push stream. */
export function sanitizePushHeaders(headers: Record<string, unknown> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'cookie' || lower === 'authorization' || lower === 'proxy-authorization') continue;
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

export function http2Push(options: PushOptions = {}) {
  const maxAssets = options.maxAssets ?? 5;
  return function pushAssetsMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!canPushRequest(req)) {
      next();
      return;
    }
    const acceptsHtml = String(req.headers.accept || '').includes('text/html');
    if (!acceptsHtml) {
      next();
      return;
    }

    const configured = typeof options.assets === 'function' ? options.assets(req) : options.assets ?? [];
    const fromLocals = Array.isArray(res.locals.pushAssets) ? res.locals.pushAssets : [];
    const assets = selectPushAssets([...configured, ...fromLocals], {
      maxAssets,
      origin: options.publicOrigin,
    });

    if (assets.length > 0) {
      res.setHeader(
        'Link',
        assets.map((asset) => `<${asset}>; rel=preload; as=${asset.endsWith('.css') ? 'style' : asset.endsWith('.woff2') ? 'font' : 'script'}`).join(', '),
      );
    }

    const push = (res as unknown as { push?: (path: string, opts: unknown) => unknown }).push;
    const enabled = options.enablePush ?? process.env.HTTP2_PUSH === '1';
    if (enabled && typeof push === 'function') {
      for (const asset of assets) {
        try {
          push.call(res, asset, { request: { headers: sanitizePushHeaders(req.headers as Record<string, unknown>) } });
        } catch {
          // Push is advisory; a failure must never fail the page.
          break;
        }
      }
    }
    next();
  };
}

export default http2Push;
