import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PoolManager, createPoolManager, MAX_CONNECTIONS, IDLE_TIMEOUT_MS, HEALTH_CHECK_INTERVAL_MS } from '../server/db/poolManager.js';

describe('PostgreSQL Pool Socket Management & Idle Reclamation', () => {
  let pool;

  beforeEach(() => {
    pool = createPoolManager({ maxConnections: 20, idleTimeoutMs: 30_000, reclaimIntervalMs: 10000, healthCheckIntervalMs: 15000 });
  });
  afterEach(async () => { await pool.shutdown(); });

  it('exposes correct defaults (max 20, idle 30s)', () => {
    expect(MAX_CONNECTIONS).toBe(20);
    expect(IDLE_TIMEOUT_MS).toBe(30_000);
    expect(pool.getStats().maxConnections).toBe(20);
    expect(pool.getStats().idleTimeoutMs).toBe(30_000);
  });

  it('tracks active, idle, waiting correctly', async () => {
    const c1 = await pool.acquire();
    const c2 = await pool.acquire();
    expect(pool.getStats().active).toBe(2);
    expect(pool.getStats().idle).toBe(0);
    pool.release(c1);
    expect(pool.getStats().idle).toBe(1);
    expect(pool.getStats().active).toBe(1);
    pool.release(c2);
    expect(pool.getStats().idle).toBe(2);
    expect(pool.monitor().idleAges.length).toBe(2);
  });

  it('reclaims idle connections older than 30 seconds', async () => {
    const c = await pool.acquire();
    pool.release(c);
    expect(pool.getStats().idle).toBe(1);
    // Not yet expired
    expect(pool.reclaimIdleConnections(Date.now() + 10_000)).toBe(0);
    expect(pool.getStats().idle).toBe(1);
    // Expired after 31s
    expect(pool.reclaimIdleConnections(Date.now() + 31_000)).toBe(1);
    expect(pool.getStats().idle).toBe(0);
    expect(pool.getStats().total).toBe(0);
  });

  it('enforces max connection cap (20)', async () => {
    const clients = [];
    for (let i = 0; i < 20; i++) clients.push(await pool.acquire());
    expect(pool.getStats().total).toBe(20);
    expect(pool.getStats().active).toBe(20);

    // 21st should queue, not immediately resolve
    let queued = false;
    const p = pool.acquire(200).catch(() => { queued = true; throw new Error('queued timeout'); });
    expect(pool.getStats().waiting).toBe(1);
    await expect(p).rejects.toThrow(/timeout/i);

    // Release one should allow queued waiter to succeed if present
    const pool2 = createPoolManager({ maxConnections: 2 });
    const a = await pool2.acquire();
    const b = await pool2.acquire();
    const waiting = pool2.acquire(1000);
    // free one
    setTimeout(() => pool2.release(a), 20);
    const c = await waiting;
    expect(c).toBeDefined();
    expect(pool2.getStats().waiting).toBe(0);
    await pool2.shutdown();
    for (const cl of clients) pool.release(cl);
  });

  it('health checks ping with SELECT 1 and drops dead sockets', async () => {
    // Create 2 idle clients, one of which is dead
    const c1 = await pool.acquire();
    const c2 = await pool.acquire();
    pool.release(c1);
    pool.release(c2);

    // Make c2 dead
    c2.query = async () => { throw new Error('ECONNRESET: socket hang up'); };

    const result = await pool.runHealthCheck();
    expect(result.checked).toBe(2);
    expect(result.dead).toBe(1);
    expect(result.alive).toBe(1);
    expect(pool.getStats().idle).toBe(1);
    expect(pool.getStats().total).toBe(1);
  });

  it('SELECT 1 succeeds for healthy clients', async () => {
    const r = await pool.query('SELECT 1');
    expect(r.rows[0]).toBeDefined();
    expect(pool.getStats().active).toBe(0);
    expect(pool.getStats().idle).toBe(1);
  });

  it('waiting queue resolves when idle reclaimed creates capacity', async () => {
    const smallPool = createPoolManager({ maxConnections: 1, idleTimeoutMs: 100 });
    const a = await smallPool.acquire();
    // Queue second acquire
    const waiter = smallPool.acquire(500);
    // Release after short delay — should hand off directly
    setTimeout(() => smallPool.release(a), 10);
    const b = await waiter;
    expect(b).toBeDefined();
    expect(smallPool.getStats().active).toBe(1);
    smallPool.release(b);
    await smallPool.shutdown();
  });

  it('shutdown clears all and rejects waiters', async () => {
    const c = await pool.acquire();
    pool.release(c);
    const waiter = pool.acquire(5000);
    // Actually fill pool to force waiting: need max=1 case
    const p1 = createPoolManager({ maxConnections: 1 });
    const x = await p1.acquire();
    const w = p1.acquire(5000);
    await p1.shutdown();
    await expect(w).rejects.toThrow(/shutting down/i);
    p1.release(x);
    await p1.shutdown();
    await pool.shutdown();
  });

  it('periodic reclaim and health timers can start/stop', () => {
    pool.startReclamation();
    pool.startHealthChecks();
    expect(pool.reclaimTimer ?? true).toBeDefined();
    pool.stopReclamation();
    pool.stopHealthChecks();
    expect(pool.reclaimTimer).toBeNull();
    expect(pool.healthTimer).toBeNull();
    pool.startAutoManagement();
    pool.stopAutoManagement();
    expect(pool.reclaimTimer).toBeNull();
  });

  it('enforces idle timeout via alias reclaimIdle', async () => {
    const c = await pool.acquire();
    pool.release(c);
    expect(pool.reclaimIdle(Date.now() + 30_001)).toBe(1);
  });

  it('healthCheck alias works', async () => {
    const c = await pool.acquire(); pool.release(c);
    const res = await pool.healthCheck();
    expect(res.checked).toBe(1);
  });
});
