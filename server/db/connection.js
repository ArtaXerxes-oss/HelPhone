/**
 * Database connection layer — JS runtime (mirrors connection.ts)
 */
import { getPoolManager, resetPoolManager, MAX_CONNECTIONS, IDLE_TIMEOUT_MS } from './poolManager.js';

let pgPool = null;

function resolveMaxConnections() {
  const raw = process.env.PG_MAX_CONNECTIONS || process.env.DATABASE_MAX_CONNECTIONS;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(Math.max(1, Math.trunc(parsed)), MAX_CONNECTIONS);
  return MAX_CONNECTIONS;
}
function resolveIdleTimeout() {
  const raw = process.env.PG_IDLE_TIMEOUT_MS || process.env.DATABASE_IDLE_TIMEOUT;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return IDLE_TIMEOUT_MS;
}
async function createPgClient() {
  const id = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    state: 'idle',
    async query(sql) {
      if (/SELECT\s+1/i.test(sql)) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    },
    release() {},
    async end() { this.__destroyed = true; },
  };
}

export function getPool() {
  if (pgPool) return pgPool;
  pgPool = getPoolManager({
    maxConnections: resolveMaxConnections(),
    idleTimeoutMs: resolveIdleTimeout(),
    createClient: () => createPgClient(),
    log: (msg, meta) => { if (process.env.DEBUG_POOL) console.log(msg, meta ?? ''); },
  });
  return pgPool;
}
export async function query(sql, params) { return getPool().query(sql, params); }
export async function getClient() { return getPool().acquire(); }
export function releaseClient(client) { getPool().release(client); }
export async function withClient(fn) {
  const client = await getClient();
  try {
    return await fn(client);
  } finally {
    releaseClient(client);
  }
}
export async function healthCheck() { return getPool().runHealthCheck(); }
export function getStats() { return getPool().getStats(); }
export async function shutdownPool() { if (pgPool) await pgPool.shutdown(); pgPool = null; resetPoolManager(); }
export async function pingDatabase(timeoutMs = 2000) {
  const start = Date.now();
  try {
    await Promise.race([query('SELECT 1'), new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), timeoutMs))]);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) { return { ok: false, latencyMs: Date.now() - start, error: e.message }; }
}
let mockReplicationLagMs = null;
let mockAsOfLsn = null;
let cachedLagMs = 0;
let lastLagCheckAt = 0;

export function setMockReplicationLag(ms) { mockReplicationLagMs = ms; }
export function setMockAsOfLsn(lsn) { mockAsOfLsn = lsn; }

export async function getReplicationLagMs() {
  if (mockReplicationLagMs !== null) return mockReplicationLagMs;
  const now = Date.now();
  if (now - lastLagCheckAt < 1000) return cachedLagMs;
  try {
    const res = await query(`SELECT COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000, 0) AS lag_ms`);
    const val = Number(res?.rows?.[0]?.lag_ms);
    cachedLagMs = Number.isFinite(val) ? Math.max(0, val) : 0;
  } catch {
    cachedLagMs = 0;
  }
  lastLagCheckAt = now;
  return cachedLagMs;
}

export async function getAsOfLsn() {
  if (mockAsOfLsn !== null) return mockAsOfLsn;
  try {
    const res = await query(`SELECT COALESCE(pg_last_wal_replay_lsn()::text, pg_current_wal_lsn()::text, '0/0') AS lsn`);
    return String(res?.rows?.[0]?.lsn || '0/0');
  } catch {
    return '0/0';
  }
}

export async function getHistoryConn(lagBudgetMs = 10000) {
  const lagMs = await getReplicationLagMs();
  const asOfLsn = await getAsOfLsn();

  if (lagMs <= lagBudgetMs) {
    const client = await getClient();
    return {
      client,
      isReplica: true,
      isReserve: false,
      isStale: false,
      lagMs,
      asOfLsn,
      release: () => releaseClient(client),
    };
  }

  try {
    const reserveClient = await getPool().acquirePrimaryReserve(1000);
    return {
      client: reserveClient,
      isReplica: false,
      isReserve: true,
      isStale: false,
      lagMs,
      asOfLsn,
      release: () => getPool().releasePrimaryReserve(reserveClient),
    };
  } catch {
    return {
      client: null,
      isReplica: false,
      isReserve: false,
      isStale: true,
      lagMs,
      asOfLsn,
      release: () => {},
    };
  }
}

// Schema migrations — lazy import avoids a circular dependency between
// connection and migrator (see migrator.js for behaviour).
export async function migrate(options = {}) {
  const { runMigrations } = await import('./migrator.js');
  return runMigrations(options);
}
export async function migrateAtStartup() {
  const { runMigrationsAtStartup } = await import('./migrator.js');
  return runMigrationsAtStartup();
}
export default { getPool, query, getClient, releaseClient, withClient, healthCheck, getStats, shutdownPool, pingDatabase };
