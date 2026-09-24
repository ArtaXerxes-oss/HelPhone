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
