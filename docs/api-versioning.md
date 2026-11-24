# API Versioning and Deprecation Policy (#947)

HelPhone exposes a versioned REST surface under `/api/v1/*` alongside the legacy unversioned `/api/*` (`v0`) surface, while keeping `/graphql` backward compatible across versions.

## Versioned Surface & Compatibility Headers

| Surface | Status | Response Headers |
|---|---|---|
| `/api/v1/*` | Current (`v1`) | `X-API-Version: v1`, `X-API-Supported-Versions: v1, v0` |
| `/api/*` | Deprecated (`v0`) | `X-API-Version: v0`, `X-API-Supported-Versions: v1, v0`, `Deprecation`, `Sunset`, `Link` |
| `/graphql` | Backward compatible | `X-API-Version: v1`, `X-API-Supported-Versions: v1, v0`, `X-GraphQL-Compatibility: backward-compatible` |

## Deprecation & Sunset Schedule

- **v0 Deprecation Date**: `Thu, 01 Oct 2026 00:00:00 GMT` (`Deprecation` header)
- **v0 Sunset Date**: `Tue, 01 Jun 2027 00:00:00 GMT` (`Sunset` header)
- **Successor Link**: `Link: </api/v1>; rel="successor-version", </docs/api-versioning>; rel="deprecation"`

Both `/api/v1/*` and `/api/*` run side by side against the same underlying store until the `v0` sunset date.

## Federation Peer Version Negotiation

Federation peers (`/api/v1/federation/*` and `/api/federation/*`) negotiate a mutually supported API version via request headers:

- `X-HelPhone-API-Version: v1` (or `v0`)
- `Accept-Version: v1`
- `Accept: application/vnd.helphone.v1+json`

The server selects the highest mutually supported version (`v1` preferred over `v0`) and returns `X-API-Negotiated-Version` and `X-API-Supported-Versions`. If a peer requests an unsupported version, the server responds with `406 Not Acceptable` and `{ "error": "unsupported_api_version", "supportedVersions": ["v1", "v0"] }`.

## Client Migration Guidance

1. **PWA & First-Party Clients**: Update REST base paths from `/api/<resource>` to `/api/v1/<resource>`.
2. **Federation Peers**: Send `X-HelPhone-API-Version: v1` on gossip/dispatch/settlement requests and switch peer URLs to `/api/v1/federation/*`.
3. **GraphQL Consumers**: Continue using `/graphql`; additive schema evolution preserves existing queries and mutations.
4. **Monitoring**: Alert on `Deprecation` / `Sunset` response headers in integration tests before `2027-06-01`.
