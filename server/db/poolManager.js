/**
 * Pool Manager — JS runtime version (mirrors poolManager.ts)
 * Node 22 strip-types not assumed, so keep plain JS.
 */
export const MAX_CONNECTIONS = 20;
export const IDLE_TIMEOUT_MS = 30000;
export const HEALTH_CHECK_INTERVAL_MS = 15000;
export const RECLAIM_INTERVAL_MS = 10000;

function createMockClient(id) {
  let destroyed = false;
  const client = {
    id,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    state: 'idle',
    async query(sql) {
      if (destroyed) throw new Error('Client has been destroyed (dead socket)');
      if (/SELECT\s+1/i.test(sql)) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    },
    release() {},
    async end() {
      destroyed = true;
      client.__destroyed = true;
    },
  };
  return client;
}

export class PoolManager {
  constructor(opts = {}) {
    this.maxConnections = opts.maxConnections ?? MAX_CONNECTIONS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.healthCheckIntervalMs = opts.healthCheckIntervalMs ?? HEALTH_CHECK_INTERVAL_MS;
    this.reclaimIntervalMs = opts.reclaimIntervalMs ?? RECLAIM_INTERVAL_MS;
    this.pingQuery = opts.pingQuery ?? 'SELECT 1';
    this.log = opts.log ?? (() => {});
    this.createClient = opts.createClient ?? (() => createMockClient(`mock-${++this.seq}`));
    this.idlePool = [];
    this.activeSet = new Set();
    this.waitingQueue = [];
    this.reclaimTimer = null;
    this.healthTimer = null;
    this.seq = 0;
  }

  getStats() {
    return {
      total: this.idlePool.length + this.activeSet.size,
      active: this.activeSet.size,
      idle: this.idlePool.length,
      waiting: this.waitingQueue.length,
      maxConnections: this.maxConnections,
      idleTimeoutMs: this.idleTimeoutMs,
    };
  }
  getPoolStats() { return this.getStats(); }
  monitor() {
    const now = Date.now();
    return { ...this.getStats(), idleAges: this.idlePool.map(e => now - e.idleSince), waitingAges: this.waitingQueue.map(w => now - w.enqueuedAt) };
  }
  totalCount() { return this.idlePool.length + this.activeSet.size; }

  reclaimIdleConnections(now = Date.now()) {
    let reclaimed = 0;
    const remaining = [];
    for (const entry of this.idlePool) {
      const age = now - entry.idleSince;
      if (age >= this.idleTimeoutMs) {
        reclaimed++;
        this.destroyClient(entry.client);
        this.log('[pool] reclaimed idle connection', { id: entry.client.id, ageMs: age });
      } else remaining.push(entry);
    }
    this.idlePool = remaining;
    if (reclaimed > 0) this.drainWaitingQueue();
    return reclaimed;
  }
  reclaimIdle(now) { return this.reclaimIdleConnections(now); }

  async runHealthCheck() {
    let checked = 0, alive = 0, dead = 0;
    const toRemove = [];
    const idleClients = [...this.idlePool];
    for (const entry of idleClients) {
      checked++;
      try { await this.pingWithTimeout(entry.client, 2000); alive++; } catch { dead++; toRemove.push(entry.client); }
    }
    for (const c of toRemove) { this.removeIdleClient(c); this.destroyClient(c); this.log('[pool] health check dropped dead socket', { id: c.id }); }
    const before = this.idlePool.length;
    this.reclaimIdleConnections();
    return { checked, alive, dead, reclaimed: before - this.idlePool.length };
  }
  healthCheck() { return this.runHealthCheck(); }

  async pingWithTimeout(client, timeoutMs) {
    await Promise.race([client.query(this.pingQuery), new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), timeoutMs))]);
  }
  destroyClient(client) { try { client.__destroyed = true; if (typeof client.end === 'function') void client.end(); } catch {} }
  removeIdleClient(client) { this.idlePool = this.idlePool.filter(e => e.client !== client); }

  drainWaitingQueue() {
    while (this.waitingQueue.length > 0 && this.idlePool.length > 0) {
      const waiter = this.waitingQueue.shift();
      const entry = this.idlePool.shift();
      if (waiter.timer) clearTimeout(waiter.timer);
      entry.client.lastUsedAt = Date.now();
      entry.client.state = 'active';
      this.activeSet.add(entry.client);
      waiter.resolve(this.wrapClient(entry.client));
    }
    while (this.waitingQueue.length > 0 && this.totalCount() < this.maxConnections) {
      const waiter = this.waitingQueue.shift();
      if (waiter.timer) clearTimeout(waiter.timer);
      Promise.resolve(this.createClient()).then(raw => {
        raw.state = 'active'; raw.lastUsedAt = Date.now(); this.activeSet.add(raw); waiter.resolve(this.wrapClient(raw));
      }).catch(err => waiter.reject(err));
      break;
    }
  }
  wrapClient(client) {
    const self = this;
    const originalRelease = client.release.bind(client);
    client.release = () => { try { originalRelease(); } catch {} self.release(client); };
    return client;
  }

  async acquire(queueTimeoutMs = 30000) {
    if (this.idlePool.length > 0) {
      const entry = this.idlePool.shift();
      entry.client.state = 'active'; entry.client.lastUsedAt = Date.now(); this.activeSet.add(entry.client);
      return this.wrapClient(entry.client);
    }
    if (this.totalCount() < this.maxConnections) {
      const raw = await this.createClient();
      raw.state = 'active'; raw.lastUsedAt = Date.now(); this.activeSet.add(raw);
      return this.wrapClient(raw);
    }
    return new Promise((resolve, reject) => {
      const enqueuedAt = Date.now();
      const waiter = { resolve, reject, enqueuedAt };
      waiter.timer = setTimeout(() => {
        this.waitingQueue = this.waitingQueue.filter(w => w !== waiter);
        reject(new Error(`Connection pool waiting queue timeout after ${queueTimeoutMs}ms (max=${this.maxConnections})`));
      }, queueTimeoutMs);
      this.waitingQueue.push(waiter);
      this.log('[pool] waiting for connection', { waiting: this.waitingQueue.length, active: this.activeSet.size });
    });
  }

  release(client) {
    if (!this.activeSet.has(client)) return;
    this.activeSet.delete(client);
    if (client.__destroyed) return;
    client.state = 'idle'; client.lastUsedAt = Date.now();
    if (this.waitingQueue.length > 0) {
      const waiter = this.waitingQueue.shift();
      if (waiter.timer) clearTimeout(waiter.timer);
      client.state = 'active'; this.activeSet.add(client); waiter.resolve(this.wrapClient(client)); return;
    }
    this.idlePool.push({ client, idleSince: Date.now() });
    while (this.totalCount() > this.maxConnections && this.idlePool.length > 0) {
      const entry = this.idlePool.pop(); this.destroyClient(entry.client);
    }
  }

  async query(sql, params) {
    const client = await this.acquire();
    try { return await client.query(sql, params); } finally { this.release(client); }
  }

  startReclamation() {
    if (this.reclaimTimer) return;
    this.reclaimTimer = setInterval(() => { this.reclaimIdleConnections(); }, this.reclaimIntervalMs);
    if (this.reclaimTimer?.unref) this.reclaimTimer.unref();
  }
  stopReclamation() { if (this.reclaimTimer) clearInterval(this.reclaimTimer); this.reclaimTimer = null; }
  startHealthChecks() {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => { void this.runHealthCheck().catch(() => {}); }, this.healthCheckIntervalMs);
    if (this.healthTimer?.unref) this.healthTimer.unref();
  }
  stopHealthChecks() { if (this.healthTimer) clearInterval(this.healthTimer); this.healthTimer = null; }
  startAutoManagement() { this.startReclamation(); this.startHealthChecks(); }
  stopAutoManagement() { this.stopReclamation(); this.stopHealthChecks(); }
  async shutdown() {
    this.stopAutoManagement();
    for (const w of this.waitingQueue) { if (w.timer) clearTimeout(w.timer); w.reject(new Error('Pool is shutting down')); }
    this.waitingQueue = [];
    for (const entry of this.idlePool) this.destroyClient(entry.client);
    this.idlePool = [];
    for (const c of [...this.activeSet]) this.destroyClient(c);
    this.activeSet.clear();
  }
}

let singleton = null;
export function getPoolManager(opts) {
  if (!singleton) {
    singleton = new PoolManager(opts);
    if (process.env.NODE_ENV !== 'test') singleton.startAutoManagement();
  }
  return singleton;
}
export function resetPoolManager() { if (singleton) void singleton.shutdown(); singleton = null; }
export function createPoolManager(opts) { return new PoolManager(opts); }
export default PoolManager;
