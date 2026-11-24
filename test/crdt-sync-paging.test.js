// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  syncRouter,
  localCrdtStore,
  getCompactedSnapshot,
  clearCompactedSnapshot,
  getStateDigest,
  SNAPSHOT_TTL_MS,
} from '../server/routes/sync.js';
import { compareForPaging, cutPage } from '../src/lib/syncPaging.js';
import { stateDigest } from '../src/lib/syncIntegrity.js';
import { makeOps, sha } from './helpers/hydration-fixtures.js';

const app = express();
app.use('/api/sync', syncRouter);

describe('paging rules (#930)', () => {
  const op = (counter, actor = 'a', instance) => ({ counter, actor, instance });

  it('orders by counter, then actor, then instance', () => {
    const sorted = [op(2, 'b'), op(1, 'b'), op(1, 'a', 'z'), op(1, 'a')].sort(compareForPaging);
    expect(sorted.map((o) => `${o.counter}:${o.actor}:${o.instance ?? ''}`)).toEqual([
      '1:a:',
      '1:a:z',
      '1:b:',
      '2:b:',
    ]);
  });

  it('cuts at the limit when the boundary is clean', () => {
    const ops = [op(1), op(2), op(3), op(4)];
    expect(cutPage(ops, 2).map((o) => o.counter)).toEqual([1, 2]);
  });

  it('never splits a run of equal counters across pages', () => {
    const ops = [op(1), op(2), op(3), op(3), op(3), op(4)];
    // Limit 3 would split the counter-3 run, so the cut steps back before it.
    expect(cutPage(ops, 3).map((o) => o.counter)).toEqual([1, 2]);
  });

  it('takes a whole run when a single tied run fills the page', () => {
    const ops = [op(3, 'a'), op(3, 'b'), op(3, 'c'), op(4)];
    expect(cutPage(ops, 2).map((o) => o.counter)).toEqual([3, 3, 3]);
  });

  it('returns everything when the list fits', () => {
    const ops = [op(1), op(2)];
    expect(cutPage(ops, 10)).toEqual(ops);
  });
});

describe('GET /api/sync/deltas (#930)', () => {
  beforeAll(() => {
    // 15,000 operations across 30 responders and 500 incidents.
    localCrdtStore.merge(makeOps(15000, { actors: 30, keys: 500 }));
  });

  it('pages through 15,000 operations with zero duplicates and no gaps', async () => {
    const seen = new Set();
    let since = {};
    let pages = 0;
    let hasMore = true;

    while (hasMore) {
      const res = await request(app)
        .get('/api/sync/deltas')
        .query({ since_vector: JSON.stringify(since), limit: 500 });
      expect(res.status).toBe(200);

      const { operations, next_vector, checksum, has_more } = res.body;
      expect(operations.length).toBeLessThanOrEqual(500);
      expect(checksum).toBe(sha(JSON.stringify(operations)));
      for (const o of operations) {
        const id = `${o.actor}:${o.counter}`;
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }

      pages++;
      since = next_vector;
      hasMore = has_more;
      if (pages > 200) throw new Error('paging did not terminate');
    }

    expect(seen.size).toBe(15000);
    expect(pages).toBeGreaterThanOrEqual(30);
  });

  it('keeps the legacy deltas key identical to operations', async () => {
    // 30 responders each have an operation at counter 1, so a limit of 30 lands
    // on a clean boundary and returns exactly one full round.
    const res = await request(app).get('/api/sync/deltas').query({ since_vector: '{}', limit: 30 });
    expect(res.body.deltas).toEqual(res.body.operations);
    expect(res.body.operations.length).toBe(30);
  });

  it('rejects a malformed since_vector instead of silently replaying from zero', async () => {
    const malformed = await request(app).get('/api/sync/deltas').query({ since_vector: 'not-json' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe('invalid_since_vector');

    const negative = await request(app)
      .get('/api/sync/deltas')
      .query({ since_vector: JSON.stringify({ 'actor-0': -1 }) });
    expect(negative.status).toBe(400);
  });

  it('clamps the page limit to the server maximum', async () => {
    const res = await request(app).get('/api/sync/deltas').query({ since_vector: '{}', limit: 50000 });
    expect(res.body.operations.length).toBeLessThanOrEqual(1000);
  });
});

describe('GET /api/sync/snapshot (#930)', () => {
  beforeEach(() => {
    clearCompactedSnapshot();
  });

  it('compacts to the winning operation per key and checksums exactly what it returns', async () => {
    const res = await request(app).get('/api/sync/snapshot');

    expect(res.status).toBe(200);
    // One winner per incident, tombstones included.
    expect(res.body.operations.length).toBe(500);
    expect(res.body.checksum).toBe(sha(JSON.stringify(res.body.operations)));
    // The vector is the store's clock at the moment the snapshot was taken.
    expect(res.body.vector['actor-0']).toBe(500);
    expect(res.body.snapshot_id).toMatch(/^snapshot-\d+$/);
  });

  it('reuses one compacted snapshot for an hour, then rebuilds it', () => {
    const first = getCompactedSnapshot(1_000);
    expect(getCompactedSnapshot(1_000 + SNAPSHOT_TTL_MS - 1)).toBe(first);

    const rebuilt = getCompactedSnapshot(1_000 + SNAPSHOT_TTL_MS);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.snapshot_id).toBe(`snapshot-${1_000 + SNAPSHOT_TTL_MS}`);
  });
});

describe('GET /api/sync/digest (#932)', () => {
  it('returns the convergence digest that join receipts are verified against', async () => {
    const res = await request(app).get('/api/sync/digest');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(getStateDigest());
    expect(res.body.highwater).toBe(15000);
    expect(res.body.hash).toBe(stateDigest(new Map(localCrdtStore.values())));
  });
});
