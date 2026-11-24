import { createHash } from 'node:crypto';
import { Router, Request, Response } from 'express';
import Canvas from 'canvas';
import Redis from 'ioredis';

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const DEFAULT_TENANT_ID = 'default';
export const DEFAULT_MAX_OG_IMAGE_BYTES = 512 * 1024; // 512 KB cap
export const MIN_OG_IMAGE_BYTES = 64;
export const DEFAULT_OG_TTL_SECONDS = 3600;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface OGPreviewOptions {
  /** Optional existence/ownership check for the requested ID within a tenant. */
  requestExists?: (requestId: string, tenantId: string) => Promise<boolean> | boolean;
  /** Maximum permitted PNG byte size (default 512 KB). */
  maxImageBytes?: number;
  /** Redis TTL in seconds (default 3600). */
  ttlSeconds?: number;
  /** Fallback tenant when none is supplied on the request. */
  defaultTenant?: string;
}

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

export function resolveTenantId(req: Request, defaultTenant = DEFAULT_TENANT_ID): string | null {
  const headerTenant = req.header('x-tenant-id');
  const queryTenant = typeof req.query.tenant === 'string' ? req.query.tenant : undefined;
  const reqTenant = (req as Request & { tenantId?: unknown }).tenantId;
  const raw =
    headerTenant ??
    queryTenant ??
    (typeof reqTenant === 'string' ? reqTenant : undefined) ??
    defaultTenant;
  if (typeof raw !== 'string' || !TENANT_ID_PATTERN.test(raw)) {
    return null;
  }
  return raw;
}

export function buildOgCacheKey(tenantId: string, requestId: string): string {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error('Invalid tenantId for OG cache key');
  }
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid requestId for OG cache key');
  }
  return `og:v1:${tenantId}:${requestId}`;
}

export function isValidPngBuffer(buf: unknown, maxBytes = DEFAULT_MAX_OG_IMAGE_BYTES): buf is Buffer {
  if (!Buffer.isBuffer(buf)) return false;
  if (buf.length < MIN_OG_IMAGE_BYTES || buf.length > maxBytes) return false;
  return buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

export function computeIntegrityHeader(buf: Buffer): string {
  return `sha256-${createHash('sha256').update(buf).digest('base64')}`;
}

function setIntegrityHeaders(res: Response, buf: Buffer, ttlSeconds: number): void {
  const sha256Hex = createHash('sha256').update(buf).digest('hex');
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', `private, max-age=${ttlSeconds}`);
  res.set('Vary', 'X-Tenant-Id');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'");
  res.set('X-OG-Integrity', computeIntegrityHeader(buf));
  res.set('ETag', `"${sha256Hex}"`);
}

export function createOGPreviewRouter(redis: Redis, options: OGPreviewOptions = {}): Router {
  const router = Router();
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_OG_IMAGE_BYTES;
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_OG_TTL_SECONDS;
  const defaultTenant = options.defaultTenant ?? DEFAULT_TENANT_ID;

  router.get('/og/:requestId', async (req: Request, res: Response) => {
    const { requestId } = req.params;
    if (!isValidRequestId(requestId)) {
      return res.status(400).json({ error: 'Invalid requestId' });
    }

    const tenantId = resolveTenantId(req, defaultTenant);
    if (!tenantId) {
      return res.status(400).json({ error: 'Invalid tenantId' });
    }

    try {
      if (options.requestExists) {
        const exists = await options.requestExists(requestId, tenantId);
        if (!exists) {
          return res.status(404).json({ error: 'Request not found' });
        }
      }

      const cacheKey = buildOgCacheKey(tenantId, requestId);
      const cached = await redis.getBuffer(cacheKey);
      if (cached) {
        if (isValidPngBuffer(cached, maxImageBytes)) {
          setIntegrityHeaders(res, cached, ttlSeconds);
          return res.send(cached);
        }
        // Evict poisoned, truncated, or oversized cached entry before regenerating.
        await redis.del(cacheKey);
      }

      const canvas = Canvas.createCanvas(1200, 630);
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#0f1419';
      ctx.fillRect(0, 0, 1200, 630);

      ctx.fillStyle = '#00d4ff';
      ctx.font = 'bold 48px Arial';
      ctx.fillText('HelPhone Help Request', 100, 150);

      ctx.fillStyle = '#ffffff';
      ctx.font = '32px Arial';
      ctx.fillText(`Request ID: ${requestId}`, 100, 250);

      ctx.fillStyle = '#00d4ff';
      ctx.font = '24px Arial';
      ctx.fillText('Emergency Response Network', 100, 550);

      const buffer = canvas.toBuffer('image/png');
      if (!isValidPngBuffer(buffer, maxImageBytes)) {
        return res.status(413).json({ error: 'Generated preview exceeds maximum allowed image size' });
      }

      await redis.setex(cacheKey, ttlSeconds, buffer);

      setIntegrityHeaders(res, buffer, ttlSeconds);
      return res.send(buffer);
    } catch (error) {
      console.error('OG preview error:', error);
      return res.status(500).json({ error: 'Failed to generate preview' });
    }
  });

  return router;
}
