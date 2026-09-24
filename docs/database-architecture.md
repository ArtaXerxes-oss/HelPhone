# Database Architecture — HelPhone

## Overview

HelPhone uses PostgreSQL (via `pg`) with a hardened connection pool manager that prevents socket exhaustion and zombie connections in high-concurrency emergency dispatch scenarios.

## Pool Manager: `server/db/poolManager.ts`

### Goals

- Monitor **active / idle / waiting** clients in real time
- Reclaim idle connections older than **30 seconds**
- Enforce **max 20 connections** (configurable via `PG_MAX_CONNECTIONS`)
- Run periodic **SELECT 1** health checks to drop dead sockets before queries fail
- Support `DEBUG_POOL=true` structured logging

### Architecture

```
                ┌─────────────────────────────────┐
                │        PoolManager (20 max)      │
  acquire() ──▶ │  ┌──────┐  ┌──────┐  ┌─────────┐ │ ──▶ query('SELECT 1')
                │  │ idle │⇄ │active│⇄ │ waiting │ │
                │  └──────┘  └──────┘  └─────────┘ │
                │      │ reclaimIdleConnections()  │
                │      │ runHealthCheck()          │
                └─────────────────────────────────┘
                          │ 30s idle timeout
                          ▼
                    destroyClient() + SELECT 1 ping
```

### Config

| Env | Default | Description |
|-----|---------|-------------|
| `DATABASE_URL` | — | Postgres connection string |
| `PG_MAX_CONNECTIONS` | `20` | Hard cap |
| `PG_IDLE_TIMEOUT_MS` | `30000` | Idle reclamation (30s) |
| `DEBUG_POOL` | `false` | Verbose pool logs |

### Background Tasks

- `startReclamation()` — interval `RECLAIM_INTERVAL_MS=10s` sweeps `idlePool`
- `startHealthChecks()` — interval `HEALTH_CHECK_INTERVAL_MS=15s` runs `SELECT 1` on every idle client
- Both timers are `unref()`'d so they don't keep Node alive in tests
- `runHealthCheck()` returns `{ checked, alive, dead, reclaimed }`

### Usage

```ts
import { getPool, query, getStats } from './server/db/connection.js';

// Simple query (acquire → query → release)
await query('SELECT * FROM requests WHERE status = $1', ['Pending']);

// Manual acquire/release
const client = await getPool().acquire();
try {
  await client.query('SELECT 1');
} finally {
  getPool().release(client);
}

// Monitoring
console.log(getStats()); // { total, active, idle, waiting, maxConnections }
console.log(getPool().monitor()); // adds idleAges / waitingAges
```

### Health Endpoint

`GET /health` and `GET /health/pool` expose pool stats for monitoring:

```json
{
  "status": "ready",
  "pool": { "total": 3, "active": 1, "idle": 2, "waiting": 0, "maxConnections": 20 },
  "compression": { "threshold": 1024, "encodings": ["br", "gzip"] }
}
```

### Connection Layer: `server/db/connection.ts`

Wraps `PoolManager` with environment-aware defaults and a fallback mock client so that CI/tests never hard-fail when `DATABASE_URL` is absent. Real `pg.Pool` is used when `pg` is installed and `DATABASE_URL` is set.

### Tests

`test/db-pool.test.js` verifies:

- Defaults (20 cap, 30s timeout)
- Active/idle/waiting tracking
- Idle reclamation after 30s
- Max cap enforcement & waiting queue timeout
- Health checks dropping dead sockets (SELECT 1)
- Shutdown & timer lifecycle

Run: `npm test -- test/db-pool.test.js`

## Logger Integration: `server/middleware/logger.ts`

Structured JSON logger that optionally attaches pool stats (`?pool=1` or `DEBUG_POOL=true`). Also exposes `poolMonitorMiddleware` to attach `res.locals.poolStats`.

```ts
app.use(logger({ slowThresholdMs: 1000 }));
app.use(poolMonitorMiddleware);
```

## Render Deployment

`render.yaml` sets:

```yaml
envVars:
  - key: PG_MAX_CONNECTIONS
    value: "20"
  - key: PG_IDLE_TIMEOUT_MS
    value: "30000"
  - key: DATABASE_URL
    sync: false
```
