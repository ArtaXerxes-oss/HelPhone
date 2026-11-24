// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { IDBFactory } from 'fake-indexeddb';
import {
  syncRouter,
  localCrdtStore,
  clearCompactedSnapshot,
  getStateDigest,
} from '../server/routes/sync.js';
import { hydratePaged } from '../src/services/crdtSync.js';
import { HydrationStore } from '../src/lib/hydrationStore.js';
import { LwwElementSet } from '../src/lib/crdt.js';
import { digestOf, dropConnectionOn, makeOps } from './helpers/hydration-fixtures.js';

// Real route, real client, real IndexedDB store (fake-indexeddb). Kept in its
// own file so the server store starts empty and the history is seeded here.

const app = express();
app.use('/api/sync', syncRouter);

const routeFetcher = async (url) => {
  const res = await request(app).get(url);
  return { ok: res.status < 400, status: res.status, json: async () => res.body };
};

const TOTAL = 15000;

describe('hydration end-to-end against the real sync route (#930–#932)', () => {
  beforeAll(async () => {
    const all = makeOps(TOTAL, { actors: 30, keys: 500 });
    clearCompactedSnapshot();
    localCrdtStore.merge(all.slice(0, 1000));
    // Build the base snapshot now, while only 1,000 operations exist. It stays
    // cached for an hour, so the remaining 14,000 operations arrive as deltas.
    const warm = await request(app).get('/api/sync/snapshot');
    expect(warm.status).toBe(200);
    localCrdtStore.merge(all.slice(1000));
  });

  it('a cold device converges through the compacted snapshot and paged deltas', async () => {
    const store = await HydrationStore.open(new IDBFactory(), 'e2e-cold');
    const doc = new LwwElementSet('device-1', 'local');

    const result = await hydratePaged({
      doc,
      fetcher: routeFetcher,
      storage: store,
      opsLog: store,
      pageSize: 500,
    });

    expect(result.resumed).toBe(false);
    expect(result.totalOps).toBe(TOTAL - 1000);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.reworkRatio).toBe(0);
    expect(digestOf(doc)).toBe(getStateDigest().hash);
    expect(result.receiptVerification).toEqual({ complete: true, receiptId: result.receipt.receiptId });
    expect(result.receipt.verified).toBe(true);
  });

  it('resumes after a dropped connection from IndexedDB, not from memory', async () => {
    const store = await HydrationStore.open(new IDBFactory(), 'e2e-resume');

    // Run 1 commits the snapshot and the first pages, then the fourth deltas
    // request drops. Nothing from run 1 survives in memory.
    await expect(
      hydratePaged({
        doc: new LwwElementSet('device-2', 'local'),
        fetcher: dropConnectionOn(routeFetcher, 4),
        storage: store,
        opsLog: store,
        pageSize: 500,
      }),
    ).rejects.toThrow('connection dropped');

    const doc = new LwwElementSet('device-2', 'local');
    const result = await hydratePaged({
      doc,
      fetcher: routeFetcher,
      storage: store,
      opsLog: store,
      pageSize: 500,
    });

    expect(result.resumed).toBe(true);
    expect(result.totalOps).toBeGreaterThan(0);
    expect(result.totalOps).toBeLessThan(TOTAL - 1000);
    expect(result.duplicatesSkipped).toBe(0);
    expect(digestOf(doc)).toBe(getStateDigest().hash);
    expect(result.receipt.verified).toBe(true);
  });
});
