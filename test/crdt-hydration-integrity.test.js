// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { hydratePaged, HydrationIntegrityError } from '../src/services/crdtSync.js';
import { HydrationStore } from '../src/lib/hydrationStore.js';
import { LwwElementSet } from '../src/lib/crdt.js';
import { createFakeServer, digestOf, dropConnectionOn, makeOps, sha } from './helpers/hydration-fixtures.js';

const CHECKPOINT = 'crdt_resume_vector';

async function openStore(name = 'hydration-test') {
  return HydrationStore.open(new IDBFactory(), name);
}

function hydrate(doc, fetcher, store, extra = {}) {
  return hydratePaged({ doc, fetcher, storage: store, opsLog: store, pageSize: 500, ...extra });
}

describe('HydrationStore (IndexedDB, #931)', () => {
  it('replays committed pages in commit order and advances the checkpoint with each page', async () => {
    const store = await openStore('replay-order');
    const a = makeOps(2);
    const b = makeOps(2, { start: 2 });
    await store.commitPage(a, CHECKPOINT, JSON.stringify({ 'actor-0': 1 }));
    await store.commitPage(b, CHECKPOINT, JSON.stringify({ 'actor-0': 2 }));

    const seen = [];
    await store.replay((ops) => seen.push(ops.map((op) => op.timestamp)));
    expect(seen).toEqual([a.map((op) => op.timestamp), b.map((op) => op.timestamp)]);
    expect(await store.getItem(CHECKPOINT)).toBe(JSON.stringify({ 'actor-0': 2 }));
  });

  it('clearOps drops every committed page but leaves the checkpoint key to its owner', async () => {
    const store = await openStore('clear-ops');
    await store.commitPage(makeOps(3), CHECKPOINT, '{}');
    await store.clearOps();
    const seen = [];
    await store.replay((ops) => seen.push(ops));
    expect(seen).toEqual([]);
  });
});

describe('hydratePaged integrity (#930)', () => {
  it('converges on the server state from a cold start, with a verified join receipt (#932)', async () => {
    const ops = makeOps(1200);
    const server = createFakeServer(ops);
    const doc = new LwwElementSet('client-a', 'local');
    const phases = [];

    const result = await hydrate(doc, server.fetcher, await openStore('cold-start'), {
      onProgress: (event) => phases.push(event.phase),
    });

    expect(result.totalOps).toBe(1200);
    expect(result.pagesApplied).toBe(3);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.reworkRatio).toBe(0);
    expect(digestOf(doc)).toBe(server.digest.hash);
    expect(result.receiptVerification).toEqual({ complete: true, receiptId: result.receipt.receiptId });
    expect(result.receipt.verified).toBe(true);
    expect(phases).toEqual(expect.arrayContaining(['snapshot', 'deltas', 'join_receipt', 'complete']));
  });

  it('rejects a page whose checksum does not match, before applying any of it', async () => {
    const ops = makeOps(1200);
    const doc = new LwwElementSet('client-b', 'local');
    const store = await openStore('tampered-checksum');
    let deltasCall = 0;
    const tamper = (payload) => {
      deltasCall++;
      return deltasCall === 2 ? { ...payload, checksum: 'f'.repeat(64) } : payload;
    };

    await expect(hydrate(doc, createFakeServer(ops, { mutateDelta: tamper }).fetcher, store)).rejects.toMatchObject({
      name: 'HydrationIntegrityError',
      reason: 'delta_checksum_mismatch',
    });
    // Page one (500 ops) was committed; the tampered page 2 was not applied.
    expect(doc.delta({}).length).toBe(500);
    expect(JSON.parse(await store.getItem(CHECKPOINT))).toEqual({ 'actor-0': 100, 'actor-1': 100, 'actor-2': 100, 'actor-3': 100, 'actor-4': 100 });
  });

  it('rejects a page whose operations were edited in transit, even with the original checksum', async () => {
    const ops = makeOps(600);
    const tamper = (payload, call) => {
      if (call !== 3) return payload;
      const edited = payload.operations.map((op, i) => (i === 0 ? { ...op, value: { status: 'evil' } } : op));
      return { ...payload, operations: edited, deltas: edited };
    };
    const doc = new LwwElementSet('client-c', 'local');

    await expect(
      hydrate(doc, createFakeServer(ops, { mutateDelta: tamper }).fetcher, await openStore('edited-page')),
    ).rejects.toMatchObject({ reason: 'delta_checksum_mismatch' });
  });

  it('rejects a snapshot whose checksum does not match', async () => {
    const ops = makeOps(10);
    const server = createFakeServer(ops, {
      mutateSnapshot: (payload) => ({
        ...payload,
        operations: [{ key: 'k', value: 1, actor: 'actor-0', counter: 1, deleted: false, timestamp: 1 }],
        vector: { 'actor-0': 1 },
      }),
    });

    await expect(
      hydrate(new LwwElementSet('client-d', 'local'), server.fetcher, await openStore('bad-snapshot')),
    ).rejects.toMatchObject({ reason: 'snapshot_checksum_mismatch' });
  });

  it('rejects a snapshot that carries an operation newer than its own vector', async () => {
    const snapshotOps = [{ key: 'k', value: 1, actor: 'actor-0', counter: 5, deleted: false, timestamp: 1 }];
    const server = createFakeServer([], {
      mutateSnapshot: (payload) => ({
        ...payload,
        operations: snapshotOps,
        vector: { 'actor-0': 1 },
        checksum: sha(JSON.stringify(snapshotOps)),
      }),
    });

    await expect(
      hydrate(new LwwElementSet('client-e', 'local'), server.fetcher, await openStore('snapshot-vector')),
    ).rejects.toMatchObject({ reason: 'snapshot_exceeds_vector' });
  });

  it('stops with paging_stalled instead of looping when the vector stops advancing', async () => {
    const server = createFakeServer(makeOps(600), {
      mutateDelta: (payload) => ({ ...payload, next_vector: {} }),
    });

    await expect(
      hydrate(new LwwElementSet('client-f', 'local'), server.fetcher, await openStore('stalled')),
    ).rejects.toMatchObject({ reason: 'paging_stalled' });
  });

  it('skips a duplicated operation inside a page and counts it as rework', async () => {
    const ops = makeOps(1200);
    const tamperFree = (payload, call) => {
      if (call !== 3) return payload;
      const operations = [...payload.operations, payload.operations[0]];
      return { ...payload, operations, deltas: operations, checksum: sha(JSON.stringify(operations)) };
    };
    const server = createFakeServer(ops, { mutateDelta: tamperFree });
    const doc = new LwwElementSet('client-g', 'local');

    const result = await hydrate(doc, server.fetcher, await openStore('duplicate'));

    expect(result.duplicatesSkipped).toBe(1);
    expect(result.totalOps).toBe(1200);
    expect(result.reworkRatio).toBeGreaterThan(0);
    expect(digestOf(doc)).toBe(server.digest.hash);
  });

  it.each([
    ['not JSON', 'not json at all'],
    ['negative counter', '{"actor-0":-4}'],
    ['non-integer counter', '{"actor-0":"seven"}'],
  ])('discards a corrupt checkpoint (%s) and cold-starts from the snapshot', async (_label, corrupt) => {
    const ops = makeOps(600);
    const server = createFakeServer(ops);
    const store = await openStore(`corrupt-${_label}`);
    await store.setItem(CHECKPOINT, corrupt);
    const doc = new LwwElementSet('client-h', 'local');
    const phases = [];

    const result = await hydrate(doc, server.fetcher, store, { onProgress: (e) => phases.push(e) });

    expect(result.resumed).toBe(false);
    expect(phases.some((e) => e.phase === 'checkpoint_reset')).toBe(true);
    expect(server.calls.some((c) => c.path === '/api/sync/snapshot')).toBe(true);
    expect(digestOf(doc)).toBe(server.digest.hash);
  });

  it('resumes after a dropped connection from the last committed page, using the durable log', async () => {
    const ops = makeOps(1200);
    const server = createFakeServer(ops);
    const store = await openStore('resume');

    // Run 1: pages one and two commit, then the third request drops.
    await expect(
      hydrate(new LwwElementSet('client-i', 'local'), dropConnectionOn(server.fetcher, 3), store),
    ).rejects.toThrow('connection dropped');
    const checkpoint = JSON.parse(await store.getItem(CHECKPOINT));
    expect(checkpoint).toEqual({ 'actor-0': 200, 'actor-1': 200, 'actor-2': 200, 'actor-3': 200, 'actor-4': 200 });

    // Run 2: a fresh in-memory doc. Committed pages are replayed from the log,
    // and paging resumes from the checkpoint without re-downloading them.
    const callsBefore = server.calls.length;
    const doc = new LwwElementSet('client-i', 'local');
    const result = await hydrate(doc, server.fetcher, store);
    const resumedCalls = server.calls.slice(callsBefore);

    expect(result.resumed).toBe(true);
    expect(resumedCalls.some((c) => c.path === '/api/sync/snapshot')).toBe(false);
    expect(JSON.parse(resumedCalls.find((c) => c.path === '/api/sync/deltas').since)).toEqual(checkpoint);
    expect(result.totalOps).toBe(200); // 1200 total minus the 1000 already committed
    expect(result.duplicatesSkipped).toBe(0);
    expect(digestOf(doc)).toBe(server.digest.hash);
    expect(result.receipt.verified).toBe(true);
  });

  it('reports a failed receipt verification when the server digest disagrees', async () => {
    const server = createFakeServer(makeOps(600), {
      digest: (digest) => ({ ...digest, hash: 'bogus-hash' }),
    });

    const result = await hydrate(new LwwElementSet('client-j', 'local'), server.fetcher, await openStore('receipt-mismatch'));

    expect(result.receiptVerification).toEqual({ complete: false, reason: 'hash_mismatch' });
    expect(result.receipt.verified).toBe(false);
  });
});

describe('hydratePaged error types', () => {
  it('exports HydrationIntegrityError with a machine-readable reason', () => {
    const err = new HydrationIntegrityError('delta_checksum_mismatch', { expected: 'a' });
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe('delta_checksum_mismatch');
    expect(err.detail).toEqual({ expected: 'a' });
  });
});
