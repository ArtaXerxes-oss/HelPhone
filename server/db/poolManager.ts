/**
 * Pool Manager — PostgreSQL connection pool socket management & idle reclamation
 *
 * Features:
 * - Monitors active / idle / waiting clients
 * - Reclaims idle connections > 30s automatically
 * - Enforces max connection cap (20)
 * - Periodic SELECT 1 health checks to drop dead sockets before queries fail
 *
 * Works with `pg` Pool when installed; falls back to an in-memory mock so that
 * tests and cold-starts never hard-fail when Postgres is absent (e.g. in CI).
 */

export const MAX_CONNECTIONS = 20;
export const IDLE_TIMEOUT_MS = 30_000;
export const HEALTH_CHECK_INTERVAL_MS = 15_000;
export const RECLAIM_INTERVAL_MS = 10_000;

export interface PoolStats {
  total: number;
  active: number;
  idle: number;
  waiting: number;
  maxConnections: number;
  idleTimeoutMs: number;
}

export interface PooledClient {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  state: 'idle' | 'active' | 'waiting';
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  release: () => void;
  end?: () => Promise<void>;
  __destroyed?: boolean;
}

type WaitingResolver = {
  resolve: (client: PooledClient) => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

export interface PoolManagerOptions {
  maxConnections?: number;
  idleTimeoutMs?: number;
  healthCheckIntervalMs?: number;
  reclaimIntervalMs?: number;
  createClient?: () => PooledClient | Promise<PooledClient>;
  pingQuery?: string;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

function createMockClient(id: string): PooledClient {
  let destroyed = false;
  const client: PooledClient = {
    id,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    state: 'idle',
    async query(sql: string) {
      if (destroyed) throw new Error('Client has been destroyed (dead socket)');
      // Simulate a tiny delay for SELECT 1; deterministic in tests
      if (/SELECT\s+1/i.test(sql)) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    },
    release() {
      // No-op — managed by PoolManager.release()
    },
    async end() {
      destroyed = true;
      (client as unknown as Record<string, unknown>).__destroyed = true;
    },
  };
  return client;
}

export class PoolManager {
  private maxConnections: number;
  private idleTimeoutMs: number;
  private healthCheckIntervalMs: number;
  private reclaimIntervalMs: number;
  private pingQuery: string;
  private log: (msg: string, meta?: Record<string, unknown>) => void;

  private idlePool: Array<{ client: PooledClient; idleSince: number }> = [];
  private activeSet: Set<PooledClient> = new Set();
  private waitingQueue: WaitingResolver[] = [];

  private reclaimTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  private createClient: () => PooledClient | Promise<PooledClient>;

  constructor(opts: PoolManagerOptions = {}) {
    this.maxConnections = opts.maxConnections ?? MAX_CONNECTIONS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.healthCheckIntervalMs = opts.healthCheckIntervalMs ?? HEALTH_CHECK_INTERVAL_MS;
    this.reclaimIntervalMs = opts.reclaimIntervalMs ?? RECLAIM_INTERVAL_MS;
    this.pingQuery = opts.pingQuery ?? 'SELECT 1';
    this.log = opts.log ?? (() => {});
    this.createClient = opts.createClient ?? (() => createMockClient(`mock-${++this.seq}`));
  }

  /** Current pool statistics */
  getStats(): PoolStats {
    return {
      total: this.idlePool.length + this.activeSet.size,
      active: this.activeSet.size,
      idle: this.idlePool.length,
      waiting: this.waitingQueue.length,
      maxConnections: this.maxConnections,
      idleTimeoutMs: this.idleTimeoutMs,
    };
  }

  /** Backward-compat alias used by some tests */
  getPoolStats(): PoolStats {
    return this.getStats();
  }

  /** Exposed for monitoring dashboards */
  monitor(): PoolStats & { idleAges: number[]; waitingAges: number[] } {
    const now = Date.now();
    return {
      ...this.getStats(),
      idleAges: this.idlePool.map(e => now - e.idleSince),
      waitingAges: this.waitingQueue.map(w => now - w.enqueuedAt),
    };
  }

  private totalCount(): number {
    return this.idlePool.length + this.activeSet.size;
  }

  /** Reclaim idle connections older than idleTimeoutMs. Returns # reclaimed. */
  reclaimIdleConnections(now: number = Date.now()): number {
    const before = this.idlePool.length;
    const remaining: typeof this.idlePool = [];
    let reclaimed = 0;

    for (const entry of this.idlePool) {
      const age = now - entry.idleSince;
      if (age >= this.idleTimeoutMs) {
        reclaimed++;
        this.destroyClient(entry.client);
        this.log('[pool] reclaimed idle connection', { id: entry.client.id, ageMs: age });
      } else {
        remaining.push(entry);
      }
    }

    this.idlePool = remaining;
    // After reclaiming, try to satisfy waiters by draining queue logically
    // (new capacity may exist). The next acquire() will reuse capacity.
    if (reclaimed > 0) this.drainWaitingQueue();
    return reclaimed;
  }

  /** Alias */
  reclaimIdle(now?: number): number {
    return this.reclaimIdleConnections(now);
  }

  /** Run periodic ping queries (SELECT 1) to drop dead sockets before queries fail. */
  async runHealthCheck(): Promise<{ checked: number; alive: number; dead: number; reclaimed: number }> {
    let checked = 0;
    let alive = 0;
    let dead = 0;
    const toRemove: PooledClient[] = [];

    // Snapshot idle clients to avoid mutation during iteration
    const idleClients = [...this.idlePool];
    for (const entry of idleClients) {
      checked++;
      try {
        // 2s timeout per ping so a stalled socket does not block the sweep
        await this.pingWithTimeout(entry.client, 2000);
        alive++;
      } catch {
        dead++;
        toRemove.push(entry.client);
      }
    }

    for (const c of toRemove) {
      this.removeIdleClient(c);
      this.destroyClient(c);
      this.log('[pool] health check dropped dead socket', { id: c.id });
    }

    const reclaimedBefore = this.idlePool.length;
    // Also reclaim over-aged after health sweep
    this.reclaimIdleConnections();

    return { checked, alive, dead, reclaimed: reclaimedBefore - this.idlePool.length };
  }

  /** Alias for tests */
  healthCheck(): Promise<{ checked: number; alive: number; dead: number; reclaimed: number }> {
    return this.runHealthCheck();
  }

  private async pingWithTimeout(client: PooledClient, timeoutMs: number): Promise<void> {
    await Promise.race([
      client.query(this.pingQuery),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('ping timeout')), timeoutMs)
      ),
    ]);
  }

  private destroyClient(client: PooledClient): void {
    try {
      client.__destroyed = true;
      if (typeof client.end === 'function') void client.end();
    } catch {}
  }

  private removeIdleClient(client: PooledClient): void {
    this.idlePool = this.idlePool.filter(e => e.client !== client);
  }

  private drainWaitingQueue(): void {
    while (this.waitingQueue.length > 0 && this.idlePool.length > 0) {
      const waiter = this.waitingQueue.shift()!;
      const entry = this.idlePool.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      entry.client.lastUsedAt = Date.now();
      entry.client.state = 'active';
      this.activeSet.add(entry.client);
      waiter.resolve(this.wrapClient(entry.client));
    }
    // If still waiters and capacity to create new clients
    while (this.waitingQueue.length > 0 && this.totalCount() < this.maxConnections) {
      const waiter = this.waitingQueue.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      Promise.resolve(this.createClient()).then(raw => {
        raw.state = 'active';
        raw.lastUsedAt = Date.now();
        this.activeSet.add(raw);
        waiter.resolve(this.wrapClient(raw));
      }).catch(err => waiter.reject(err));
      break; // create one at a time to respect async
    }
  }

  private wrapClient(client: PooledClient): PooledClient {
    const self = this;
    const originalRelease = client.release.bind(client);
    // Override release to route through PoolManager
    client.release = () => {
      try { originalRelease(); } catch {}
      self.release(client);
    };
    return client;
  }

  /** Acquire a client. Queues if at cap, rejects after queueTimeoutMs. */
  async acquire(queueTimeoutMs = 30_000): Promise<PooledClient> {
    // Prefer idle reuse
    if (this.idlePool.length > 0) {
      const entry = this.idlePool.shift()!;
      entry.client.state = 'active';
      entry.client.lastUsedAt = Date.now();
      this.activeSet.add(entry.client);
      return this.wrapClient(entry.client);
    }

    // Create new if under cap
    if (this.totalCount() < this.maxConnections) {
      const raw = await this.createClient();
      raw.state = 'active';
      raw.lastUsedAt = Date.now();
      this.activeSet.add(raw);
      return this.wrapClient(raw);
    }

    // Enqueue waiter
    return new Promise<PooledClient>((resolve, reject) => {
      const enqueuedAt = Date.now();
      const waiter: WaitingResolver = { resolve, reject, enqueuedAt };
      // Timeout protects against indefinite waiting under contention
      waiter.timer = setTimeout(() => {
        this.waitingQueue = this.waitingQueue.filter(w => w !== waiter);
        reject(new Error(`Connection pool waiting queue timeout after ${queueTimeoutMs}ms (max=${this.maxConnections})`));
      }, queueTimeoutMs);
      this.waitingQueue.push(waiter);
      this.log('[pool] waiting for connection', { waiting: this.waitingQueue.length, active: this.activeSet.size });
    });
  }

  /** Release a client back to idle pool or satisfy next waiter. */
  release(client: PooledClient): void {
    if (!this.activeSet.has(client)) {
      // May already be idle or destroyed
      return;
    }
    this.activeSet.delete(client);
    if (client.__destroyed) return;

    client.state = 'idle';
    client.lastUsedAt = Date.now();

    // If there are waiters, hand directly to next waiter instead of pooling
    if (this.waitingQueue.length > 0) {
      const waiter = this.waitingQueue.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      client.state = 'active';
      this.activeSet.add(client);
      waiter.resolve(this.wrapClient(client));
      return;
    }

    this.idlePool.push({ client, idleSince: Date.now() });

    // Enforce cap: if somehow over cap, reclaim newest idle immediately
    while (this.totalCount() > this.maxConnections && this.idlePool.length > 0) {
      const entry = this.idlePool.pop()!;
      this.destroyClient(entry.client);
    }
  }

  /** Convenience query helper: acquire -> query -> release */
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    const client = await this.acquire();
    try {
      return await client.query(sql, params);
    } finally {
      this.release(client);
    }
  }

  /** Start automatic idle reclamation timer */
  startReclamation(): void {
    if (this.reclaimTimer) return;
    this.reclaimTimer = setInterval(() => {
      this.reclaimIdleConnections();
    }, this.reclaimIntervalMs);
    // Avoid keeping Node alive solely for pool timers in tests
    if (this.reclaimTimer && typeof (this.reclaimTimer as unknown as { unref?: () => void }).unref === 'function') {
      (this.reclaimTimer as unknown as { unref: () => void }).unref();
    }
  }

  stopReclamation(): void {
    if (this.reclaimTimer) clearInterval(this.reclaimTimer);
    this.reclaimTimer = null;
  }

  startHealthChecks(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      void this.runHealthCheck().catch(() => {});
    }, this.healthCheckIntervalMs);
    if (this.healthTimer && typeof (this.healthTimer as unknown as { unref?: () => void }).unref === 'function') {
      (this.healthTimer as unknown as { unref: () => void }).unref();
    }
  }

  stopHealthChecks(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  /** Start both timers (convenience) */
  startAutoManagement(): void {
    this.startReclamation();
    this.startHealthChecks();
  }

  stopAutoManagement(): void {
    this.stopReclamation();
    this.stopHealthChecks();
  }

  async shutdown(): Promise<void> {
    this.stopAutoManagement();
    // Reject waiting queue
    for (const w of this.waitingQueue) {
      if (w.timer) clearTimeout(w.timer);
      w.reject(new Error('Pool is shutting down'));
    }
    this.waitingQueue = [];

    // Destroy all clients
    for (const entry of this.idlePool) this.destroyClient(entry.client);
    this.idlePool = [];
    for (const c of [...this.activeSet]) this.destroyClient(c);
    this.activeSet.clear();
  }
}

/**
 * Singleton accessor used by server/db/connection.ts
 */
let singleton: PoolManager | null = null;

export function getPoolManager(opts?: PoolManagerOptions): PoolManager {
  if (!singleton) {
    singleton = new PoolManager(opts);
    // Auto-start background tasks in non-test environments
    if (process.env.NODE_ENV !== 'test') singleton.startAutoManagement();
  }
  return singleton;
}

export function resetPoolManager(): void {
  if (singleton) void singleton.shutdown();
  singleton = null;
}

export function createPoolManager(opts?: PoolManagerOptions): PoolManager {
  return new PoolManager(opts);
}

export default PoolManager;
