// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { NamespacedCache, namespacedKey } from '../server/lib/sqlCache.ts';

describe('NamespacedCache', () => {
  it('keeps REST and GraphQL projections in separate namespaces', () => {
    const cache = new NamespacedCache();
    cache.set('rest', 'dispatch:INC-1', { projection: 'rest' });
    cache.set('gql', 'dispatch:INC-1', { projection: 'gql' });

    expect(cache.get('rest', 'dispatch:INC-1')).toEqual({ projection: 'rest' });
    expect(cache.get('gql', 'dispatch:INC-1')).toEqual({ projection: 'gql' });
    expect(namespacedKey('rest', 'k')).not.toBe(namespacedKey('gql', 'k'));
  });

  it('invalidates an entity across every surface at once', () => {
    const cache = new NamespacedCache();
    cache.set('rest', 'dispatch:INC-1', { version: 1 });
    cache.set('gql', 'dispatch:INC-1', { version: 1 });
    cache.set('rest', 'dispatch:INC-2', { version: 1 });

    expect(cache.invalidate('dispatch:INC-1')).toBe(2);
    expect(cache.get('rest', 'dispatch:INC-1')).toBeUndefined();
    expect(cache.get('gql', 'dispatch:INC-1')).toBeUndefined();
    expect(cache.get('rest', 'dispatch:INC-2')).toEqual({ version: 1 });
    expect(cache.stats().invalidations).toBe(1);
  });

  it('expires entries at the TTL boundary', () => {
    let now = 1_000;
    const cache = new NamespacedCache({ now: () => now, jitterRatio: 0 });
    cache.set('rest', 'k', 'v', 50);
    expect(cache.get('rest', 'k')).toBe('v');
    now = 1_049;
    expect(cache.get('rest', 'k')).toBe('v');
    now = 1_050;
    expect(cache.get('rest', 'k')).toBeUndefined();
  });

  it('coalesces concurrent misses into one load', async () => {
    const cache = new NamespacedCache();
    let loads = 0;
    const load = vi.fn(async () => {
      loads++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { version: 1 };
    });

    const [a, b, c] = await Promise.all([
      cache.withCache('rest', 'dispatch:INC-1', load),
      cache.withCache('rest', 'dispatch:INC-1', load),
      cache.withCache('rest', 'dispatch:INC-1', load),
    ]);

    expect(loads).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(cache.stats().coalesced).toBe(2);
  });

  it('bounds the entry count', () => {
    const cache = new NamespacedCache({ maxEntries: 3, jitterRatio: 0 });
    for (let i = 0; i < 10; i++) cache.set('rest', `k${i}`, i);
    expect(cache.stats().size).toBeLessThanOrEqual(3);
  });

  it('bypasses both read and write when requested', async () => {
    const cache = new NamespacedCache();
    const first = await cache.withCache('rest', 'k', () => 'a', { bypass: true });
    const second = await cache.withCache('rest', 'k', () => 'b', { bypass: true });
    expect(first).toBe('a');
    expect(second).toBe('b');
    expect(cache.get('rest', 'k')).toBeUndefined();
  });

  it('applies bounded jitter to TTLs', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    let now = 0;
    const cache = new NamespacedCache({ now: () => now, jitterRatio: 0.2 });
    cache.set('rest', 'k', 'v', 100);
    // max jitter is +20%, so 119ms is alive and 121ms is expired.
    now = 119;
    expect(cache.get('rest', 'k')).toBe('v');
    now = 121;
    expect(cache.get('rest', 'k')).toBeUndefined();
    random.mockRestore();
  });
});
