# API Documentation — HelPhone

## Base URLs

- Local: `http://localhost:3001`
- Production: `https://helphone.onrender.com`

## Endpoints

### Health

`GET /health` and `GET /zk/health`

```json
{
  "status": "ready",
  "ready": true,
  "pool": { "total": 2, "active": 0, "idle": 2, "waiting": 0, "maxConnections": 20 },
  "compression": { "threshold": 1024, "encodings": ["br", "gzip"] }
}
```

`GET /health/pool`

Detailed pool diagnostics: `idleAges`, `waitingAges`.

### ZK Prover

`POST /zk/prove`

```json
{
  "inputs": {
    "user_x": "1800000000",
    "user_y": "900000000",
    "secret_id": "12345",
    "box_x_min": "0",
    "box_x_max": "3600000000",
    "box_y_min": "0",
    "box_y_max": "1800000000",
    "campaign_id": "1",
    "recipient_address": "123..."
  }
}
```

Response:

```json
{ "success": true, "proof": "ab12...", "nullifier": "12345" }
```

## Performance: Brotli & Gzip Compression

### Middleware: `server/middleware/compression.ts`

Uses `shrink-ray-current` when available, falls back to Node `zlib`.

| Property | Value |
|----------|-------|
| Threshold | `1024` bytes (1KB) — payloads smaller than this are not compressed |
| Encodings | `br` (Brotli, preferred) → `gzip` → `deflate` negotiated via `Accept-Encoding` |
| Quality | Brotli `q=4`, Gzip `level=6` |
| Bypass | `image/*`, `video/*`, `audio/*`, `font/*`, `application/zip`, `*.png`, `*.jpg`, `*.webp`, `*.mp4`, `*.zip`, `*.gz`, `*.br`, `*.woff2`, `*.wasm`, already-encoded responses |

### How it Works

- `Vary: Accept-Encoding` is always set
- Response body is buffered; if `body.length < threshold` it is sent uncompressed
- Preferred encoding is chosen from `Accept-Encoding` (`q=0` honored)
- Compressed body is sent only if it saves >5% (`compressed.length < original *0.95`)
- On failure, falls back to uncompressed
- Debug logs when `DEBUG_COMPRESSION=true`

### Bandwidth Savings

Measured on a realistic `GET /api/requests` JSON payload (~15KB, 80 repeat objects):

- Original: ~15,000 bytes
- Brotli (q=4): ~4,200 bytes (~72% savings)
- Gzip (level 6): ~4,800 bytes (~68% savings)
- Meets the **65% reduction** SLO across network monitoring suites

Verify:

```js
import { measureCompressionSavings } from './server/middleware/compression.js';
const r = await measureCompressionSavings(jsonString, 'br');
console.log(`${r.savingsPct.toFixed(1)}% saved`); // ~72%
```

### Configuration

```yaml
# render.yaml / env
COMPRESSION_THRESHOLD: "1024"
DEBUG_COMPRESSION: "false"
```

Express setup:

```ts
import { compression } from './server/middleware/compression.js';
app.use(compression({ threshold: 1024 }));
```

### Interaction with Caching

- Binary assets are never compressed (they are already compressed or would waste CPU)
- `Content-Encoding` is only set when compression actually shrinks the payload
- `Content-Length` is always updated to the compressed length

## Error Handling

| Status | Meaning |
|--------|---------|
| 400 | Missing `inputs` |
| 500 | Prover error (`err.message`) |

## GraphQL API (#528)

`POST /graphql` (Apollo Server 5, mounted alongside the REST routes). One endpoint over the Postgres-backed help-request data; REST endpoints are unchanged.

```graphql
type Query {
  health: Health!
  requests(status: String, limit: Int = 20, offset: Int = 0): [HelpRequest!]!
  request(id: ID!): HelpRequest
  verifications(wallet: String!, limit: Int = 10): [Verification!]!
  me: AuthUser
}
```

`HelpRequest` exposes `responders`, `responderCount` and `arrivedCount`. Only the indexed columns are typed (`id`, `status`, `created_at`, `request_id`, `arrived`, `wallet`, `recorded_at`); any other column on the row is returned in `attributes` (JSON) so the schema never guesses at columns.

```bash
curl -s localhost:3001/graphql \
  -H 'content-type: application/json' -H 'apollo-require-preflight: true' \
  -d '{"query":"{ requests(status:\"Pending\", limit:20) { id createdAt responderCount responders { arrived } } }"}'
```

### N+1 batching

Every nested field goes through a [DataLoader](https://github.com/graphql/dataloader), created per request in `createLoaders` (`server/graphql/resolvers.ts`). A page of 25 requests with `responders` costs **2 queries** (the page, plus one `WHERE request_id = ANY($1)` for all 25), not 26. Verification history for several wallets is likewise one window-function query. Loaders are never shared across requests, so one caller can never see another's cached rows.

### Limits

| Guard | Value |
| --- | --- |
| `limit` | Clamped to 1-100 (default 20 for requests, 10 for verifications) |
| `offset` | Clamped to >= 0 |
| Root fields per operation | 10 (blocks alias fan-out) |
| Request body | 1 MB (shared `express.json` limit) |
| Introspection and landing page | Disabled when `NODE_ENV=production` |

All filters are bound parameters (`$1`, `$2`, ...); nothing from a query is interpolated into SQL.

### Authentication

Reads are public. `me` returns the caller when the request carries the same signed headers as the REST API (`X-Public-Key`, `X-Timestamp`, `X-Signature`, optional `X-Algorithm`), verified by the shared `verifyRequestAuth` in `server/middleware/auth.ts`. The signed payload is `POST:/:<timestamp>:<JSON body>` (the path is `/` because the router is mounted at `/graphql`, as with `req.path` on any mounted route).

- No auth headers: anonymous, `me` is `null`.
- Auth headers present but invalid, stale or incomplete: `401` with `extensions.code = "UNAUTHENTICATED"`. A bad credential never silently degrades to anonymous.

Apollo's CSRF prevention is on, so browser clients must send `content-type: application/json` or an `apollo-require-preflight` header.
