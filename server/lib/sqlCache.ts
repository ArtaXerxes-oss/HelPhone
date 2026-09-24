import Redis from 'ioredis';
import crypto from 'crypto';

export interface CacheOptions {
  ttl?: number;
  prefix?: string;
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
