import type { NextFunction, Request, Response } from 'express';

export type ApiVersion = 'v1' | 'v0';

export const API_VERSION_POLICY = {
  currentVersion: 'v1' as ApiVersion,
  supportedVersions: ['v1', 'v0'] as ApiVersion[],
  unversionedDeprecatedAt: 'Thu, 01 Oct 2026 00:00:00 GMT',
  unversionedSunsetAt: 'Tue, 01 Jun 2027 00:00:00 GMT',
  migrationGuidePath: '/docs/api-versioning',
} as const;

export interface VersionNegotiationResult {
  ok: boolean;
  negotiatedVersion: ApiVersion | null;
  supportedVersions: ApiVersion[];
  requested?: string;
  error?: string;
}

function parseRequestedVersions(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const joined = Array.isArray(raw) ? raw.join(',') : raw;
  const tokens: string[] = [];

  for (const part of joined.split(',')) {
    const trimmed = part.trim().toLowerCase();
    if (!trimmed) continue;
    const vendorMatch = trimmed.match(/application\/vnd\.helphone\.(v\d+)\+json/);
    if (vendorMatch) {
      tokens.push(vendorMatch[1]);
      continue;
    }
    if (/^v\d+$/.test(trimmed)) {
      tokens.push(trimmed);
      continue;
    }
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      tokens.push(`v${trimmed.split('.')[0]}`);
      continue;
    }
    if (!trimmed.includes('/')) {
      tokens.push(trimmed);
    }
  }

  return tokens;
}

/**
 * Negotiate the highest mutually supported API version for federation peers
 * or version-aware clients. Defaults to `v1` when no version preference is sent.
 */
export function negotiatePeerVersion(
  requestedHeader?: string | string[],
): VersionNegotiationResult {
  const requested = parseRequestedVersions(requestedHeader);
  if (requested.length === 0) {
    return {
      ok: true,
      negotiatedVersion: API_VERSION_POLICY.currentVersion,
      supportedVersions: [...API_VERSION_POLICY.supportedVersions],
    };
  }

  for (const candidate of API_VERSION_POLICY.supportedVersions) {
    if (requested.includes(candidate)) {
      return {
        ok: true,
        negotiatedVersion: candidate,
        supportedVersions: [...API_VERSION_POLICY.supportedVersions],
        requested: requested.join(','),
      };
    }
  }

  return {
    ok: false,
    negotiatedVersion: null,
    supportedVersions: [...API_VERSION_POLICY.supportedVersions],
    requested: requested.join(','),
    error: `Unsupported API version (${requested.join(', ')}). Supported: ${API_VERSION_POLICY.supportedVersions.join(', ')}`,
  };
}

/**
 * Emit API version compatibility headers and RFC 8594/9745 Deprecation + Sunset
 * headers on legacy unversioned (`v0`) routes.
 */
export function apiVersionMiddleware(version: ApiVersion) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-API-Version', version);
    res.setHeader('X-API-Supported-Versions', API_VERSION_POLICY.supportedVersions.join(', '));

    if (version === 'v0') {
      res.setHeader('Deprecation', API_VERSION_POLICY.unversionedDeprecatedAt);
      res.setHeader('Sunset', API_VERSION_POLICY.unversionedSunsetAt);
      res.setHeader(
        'Link',
        `</api/v1>; rel="successor-version", <${API_VERSION_POLICY.migrationGuidePath}>; rel="deprecation"`,
      );
    }

    next();
  };
}

/**
 * Federation peer version negotiation middleware (#947).
 */
export function federationVersionNegotiationMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requested =
      req.headers['x-helphone-api-version'] ??
      req.headers['accept-version'] ??
      req.headers.accept;
    const result = negotiatePeerVersion(requested);

    res.setHeader('X-API-Supported-Versions', result.supportedVersions.join(', '));
    if (!result.ok || !result.negotiatedVersion) {
      res.status(406).json({
        error: 'unsupported_api_version',
        message: result.error,
        supportedVersions: result.supportedVersions,
      });
      return;
    }

    res.setHeader('X-API-Negotiated-Version', result.negotiatedVersion);
    next();
  };
}

/**
 * Keep `/graphql` backward compatible across API versions while advertising
 * compatibility metadata.
 */
export function graphqlCompatibilityMiddleware() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-API-Version', API_VERSION_POLICY.currentVersion);
    res.setHeader('X-API-Supported-Versions', API_VERSION_POLICY.supportedVersions.join(', '));
    res.setHeader('X-GraphQL-Compatibility', 'backward-compatible');
    next();
  };
}
