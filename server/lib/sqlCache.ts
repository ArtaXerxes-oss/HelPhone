/**
 * Namespaced cache with shared invalidation.
 *
 * Cache keys are prefixed by surface (`rest:v1:` / `gql:v1:`) so a REST read
 * and a GraphQL read can never accidentally share a value with different
 * projection/nullability semantics. Invalidating an entity clears every
 * surface namespace at once, which is what makes a dispatch write immediately
 * visible to both APIs.
 *
 * Also supports Redis-backed SQLCache for distributed SQL query caching.
 */

import crypto from 'crypto';
import type Redis from 'ioredis';

export type CacheSource = 'rest' | 'gql';

export interface CacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  jitterRatio?: number;
  now?: () => number;
  ttl?: number;
  prefix?: string;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export function namespacedKey(source: CacheSource, key: string, version = 'v1'): string {
  return `${source}:${version}:${key}`;
}

export class NamespacedCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly jitterRatio: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;
  private invalidations = 0;
  private coalesced = 0;

  constructor(options: CacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5_000;
    this.maxEntries = options.maxEntries ?? 1_000;
    this.jitterRatio = options.jitterRatio ?? 0.2;
    this.now = options.now ?? (() => Date.now());
  }

  get<T>(source: CacheSource, key: string): T | undefined {
    const namespaced = namespacedKey(source, key);
    const entry = this.entries.get(namespaced);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(namespaced);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value as T;
  }

  set<T>(source: CacheSource, key: string, value: T, ttlMs = this.ttlMs): void {
    if (this.entries.size >= this.maxEntries) this.evictOldest();
    const jitter = 1 + (Math.random() * 2 - 1) * this.jitterRatio;
    this.entries.set(namespacedKey(source, key), {
      value,
      expiresAt: this.now() + Math.max(1, ttlMs * jitter),
    });
  }

  /**
   * Read-through with request coalescing: concurrent misses share one load.
   * The same logical key is independent per source namespace.
   */
  async withCache<T>(
    source: CacheSource,
    key: string,
    load: () => Promise<T> | T,
    options: { ttlMs?: number; bypass?: boolean } = {},
  ): Promise<T> {
    if (options.bypass) return load();

    const cached = this.get<T>(source, key);
    if (cached !== undefined) return cached;

    const namespaced = namespacedKey(source, key);
    const existing = this.inFlight.get(namespaced);
    if (existing) {
      this.coalesced++;
      return existing as Promise<T>;
    }

    const promise = Promise.resolve()
      .then(load)
      .then((value) => {
        this.set(source, key, value, options.ttlMs);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(namespaced);
      });
    this.inFlight.set(namespaced, promise as Promise<unknown>);
    return promise;
  }

  /** Invalidate an entity across every surface namespace. */
  invalidate(key: string): number {
    this.invalidations++;
    let removed = 0;
    for (const source of ['rest', 'gql'] as const) {
      if (this.entries.delete(namespacedKey(source, key))) removed++;
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  stats() {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      invalidations: this.invalidations,
      coalesced: this.coalesced,
      hitRate: this.hits / Math.max(1, this.hits + this.misses),
    };
  }

  private evictOldest(): void {
    const oldest = this.entries.keys().next();
    if (!oldest.done) this.entries.delete(oldest.value);
  }
}

export class SQLCache {
  private redis: Redis;
  private prefix: string;
  private invalidationPatterns: Map<string, RegExp>;

  constructor(redis: Redis, prefix = 'sql:') {
    this.redis = redis;
    this.prefix = prefix;
    this.invalidationPatterns = new Map();
  }

  generateKey(query: string, params?: unknown[]): string {
    const hash = crypto.createHash('sha256')
      .update(query + JSON.stringify(params || []))
      .digest('hex');
    return `${this.prefix}${hash}`;
  }

  async get<T>(query: string, params?: unknown[]): Promise<T | null> {
    const key = this.generateKey(query, params);
    const cached = await this.redis.get(key);
    return cached ? JSON.parse(cached) : null;
  }

  async set<T>(query: string, data: T, options: CacheOptions = {}): Promise<void> {
    const key = this.generateKey(query);
    const ttl = options.ttl || 3600;
    await this.redis.setex(key, ttl, JSON.stringify(data));
  }

  async invalidate(pattern: string): Promise<number> {
    const keys = await this.redis.keys(`${this.prefix}*`);
    const regex = new RegExp(pattern);
    const toDelete = keys.filter(k => regex.test(k));
    if (toDelete.length === 0) return 0;
    return await this.redis.del(...toDelete);
  }

  async clear(): Promise<void> {
    const keys = await this.redis.keys(`${this.prefix}*`);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}

let sharedCache: NamespacedCache | null = null;

export function getSqlCache(options?: CacheOptions): NamespacedCache {
  if (!sharedCache) sharedCache = new NamespacedCache(options);
  return sharedCache;
}

export function resetSqlCache(): void {
  sharedCache?.clear();
  sharedCache = null;
}

export function invalidateIncident(incidentId: string): void {
  getSqlCache().invalidate(`dispatch:${incidentId}`);
}

export default NamespacedCache;
