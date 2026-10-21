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

## Automated Maintenance: `server/db/maintenance.ts`

Dead tuples left by UPDATE/DELETE bloat tables and slow scans. The scheduler
vacuums and re-indexes bloated tables during a low-traffic window.

### How it works

1. Every `DB_MAINTENANCE_INTERVAL_MS` (default 15 min) a tick runs.
2. It does nothing outside the UTC window `[DB_MAINTENANCE_WINDOW_START_UTC,
   DB_MAINTENANCE_WINDOW_END_UTC)` (default 02:00–05:00; may wrap midnight).
3. It reads `pg_stat_user_tables` and computes
   `dead% = n_dead_tup / (n_live_tup + n_dead_tup) × 100` per table.
4. Each table above `DB_BLOAT_THRESHOLD_PCT` (default **20**) and with at least
   `DB_MAINTENANCE_MIN_TUPLES` (default 1000) tuples, worst first, gets
   `VACUUM (ANALYZE) "schema"."table"` then
   `REINDEX TABLE CONCURRENTLY "schema"."table"`. A table is re-indexed at most
   once per `DB_REINDEX_COOLDOWN_MS` (default 7 days, tracked in memory).

### Non-blocking guarantees

- Plain `VACUUM` is used, **never `VACUUM FULL`**: it takes no exclusive lock, so
  reads and writes continue. (PostgreSQL has no `VACUUM ... CONCURRENTLY`.)
- `REINDEX ... CONCURRENTLY` (PostgreSQL 12+) rebuilds indexes without blocking
  writes. It is slower and uses extra disk while running; if it fails it can
  leave an `INVALID` index behind (`\d table`), which should be dropped and retried.
- Both statements are rejected inside a transaction block, so they are sent one
  at a time on a dedicated pooled client (`withClient` in `connection.ts`).
- Runs are single-flight; a slow pass makes later ticks skip rather than pile up.
  One table failing is logged and does not stop the rest.

### Config

| Env | Default | Description |
|-----|---------|-------------|
| `DB_MAINTENANCE_ENABLED` | `false` | Opt-in switch |
| `DB_BLOAT_THRESHOLD_PCT` | `20` | Dead-tuple % that triggers maintenance |
| `DB_MAINTENANCE_WINDOW_START_UTC` | `2` | Window opens (hour, inclusive) |
| `DB_MAINTENANCE_WINDOW_END_UTC` | `5` | Window closes (hour, exclusive) |
| `DB_MAINTENANCE_INTERVAL_MS` | `900000` | Tick interval |
| `DB_REINDEX_COOLDOWN_MS` | `604800000` | Min gap between re-indexes of a table |
| `DB_MAINTENANCE_MIN_TUPLES` | `1000` | Skip tiny tables |

Invalid values fall back to the default. `pg_stat_user_tables` counters are
estimates, so the percentage is approximate. Per-table autovacuum tuning is
still the first line of defence; this is a backstop.

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

---

# Replication Lag, Lag-Tolerant Reads & Exactly-Once Projection (ISP-065)

## 1. Replication Lag SLO & Load-Shedding Table

During disaster spikes, bulk rejoin operations and telemetry heartbeats can drive 5k–10k writes/min on the primary, generating replica replay lags from 30s to 180s. To prevent phantom stale reads, double-dispatch, and pool exhaustion, the read/write layer enforces strict routing:

| Replay Lag | History Read Routing | Telemetry Ingestion | DDL Migrations | Background Maintenance | UI Demarcation |
|---|---|---|---|---|---|
| **≤ 10,000 ms** (Normal) | Read replica | Normal direct write | Allowed | Scheduled ANALYZE / Vacuum | Normal display |
| **10,000 – 30,000 ms** (Lagging) | Fallback to **primary-reserve** (max 5 conns); if exhausted, return **HTTP 209 Stale** with `Retry-After: 5` | Normal direct write | Block non-urgent DDL (>15s) | Maintenance continues | **`⚠️ Stale ~Xs`** badge |
| **> 30,000 ms** (Severe Lag) | HTTP 209 Stale (or primary reserve) | **Shed to Redis buffer** (`redisPubSub.js`) | Block all non-urgent DDL | **Paused** (skips pass) | Stale badge + dispatch confirm override required |

### Headers Emitted on Every Read

Every response from `/api/history` contains:
- `X-Replica-Lag-Ms`: Replay lag in milliseconds (sampled with 1s cache).
- `X-As-Of-LSN`: Log Sequence Number of the current replica replay position.
- `X-Next-Cursor`: Keyset cursor for the subsequent page.

## 2. Monotonic History: Keyset Cursor Pagination

`LIMIT / OFFSET` pagination across moving replication boundaries produces phantom holes and duplicate rows. HelPhone enforces keyset cursor pagination:

```sql
SELECT id, server_seq, op_id, status, details, created_at
FROM dispatch_log
WHERE (server_seq, id) > ($cursor_seq, $cursor_id)
ORDER BY server_seq ASC, id ASC
LIMIT $limit;
```

Cursors are base64-encoded strings: `${server_seq}:${id}`.
- Paginating across partition boundaries guarantees zero row skips and zero duplicate rows even while catch-up replay moves the replica snapshot.

## 3. Transactional Exactly-Once Indexer (`server/indexer/exporter.ts`)

To prevent replay duplicates or dropped batches across daemon restarts and failovers:
1. **Advisory Lock Singleton:** Exporter acquires `pg_advisory_xact_lock(hashtext('exporter'))` inside the transaction.
2. **Single Transaction Boundary:**
   ```sql
   BEGIN;
   SELECT pg_advisory_xact_lock(hashtext('exporter'));

   -- Idempotent projection
   INSERT INTO dispatch_log (doc_id, client_id, clock, op_id, status, details)
   VALUES ($1, $2, $3, $4, $5, $6)
   ON CONFLICT (doc_id, client_id, clock) DO NOTHING;

   -- Checkpoint committed atomically with projection
   INSERT INTO indexer_checkpoint (component, last_lsn, last_seq, updated_at)
   VALUES ('exporter', $lsn, $seq, NOW())
   ON CONFLICT (component) DO UPDATE
     SET last_lsn = EXCLUDED.last_lsn,
         last_seq = EXCLUDED.last_seq,
         updated_at = NOW();

   COMMIT;
   ```
3. **Parser Gap Detector (`server/indexer/parser.ts`):** Validates monotonic per-client clock sequences. Any non-contiguous clock step records an event in `indexer_gap_log` and triggers an out-of-band backfill request rather than silently dropping batches.

## 4. Runbook: Replication Slot Bloat Break-Glass

When logical replication lag exceeds 10 minutes sustained and disk consumption on the primary WAL partition crosses 80%:

1. **Verify Lag and Slot Retained Size:**
   ```sql
   SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
   FROM pg_replication_slots;
   ```
2. **Confirm Two-Person Approval:** Break-glass slot dropping requires authorization from two maintainers as documented in CODEOWNERS.
3. **Drop Slot:**
   ```sql
   SELECT pg_drop_replication_slot('history_replica_slot');
   ```
4. **Trigger Replica Reseed:**
   - Put read routing into primary-reserve mode (`FORCE_PRIMARY_HISTORY=true`).
   - Run pg_basebackup or snapshot restore to recreate replica.
   - Recreate slot: `SELECT pg_create_logical_replication_slot('history_replica_slot', 'pgoutput');`.
   - Re-enable replica routing once replay lag falls under 10s.

