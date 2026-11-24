/**
 * Shared fixtures for the hydration tests (#930–#932).
 *
 * `createFakeServer` speaks the same wire protocol as server/routes/sync.ts,
 * using the same paging rules (src/lib/syncPaging.js), and adds hooks so a test
 * can tamper with a response, duplicate operations, or stall paging.
 */
import { createHash } from 'node:crypto';
import { LwwElementSet } from '../../src/lib/crdt.js';
import { stateDigest, sumVector } from '../../src/lib/syncIntegrity.js';
import { compareForPaging, cutPage } from '../../src/lib/syncPaging.js';

export const sha = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Deterministic history: `count` operations spread over `actors` actors with
 * contiguous per-actor counters, `keys` distinct keys and unique timestamps, so
 * last-writer-wins has no ties and replay order cannot change the result.
 */
export function makeOps(count, { actors = 5, keys = 40, start = 0 } = {}) {
  const counters = new Map();
  const ops = [];
  for (let i = start; i < start + count; i++) {
    const actor = `actor-${i % actors}`;
    const counter = (counters.get(actor) ?? 0) + 1;
    counters.set(actor, counter);
    ops.push({
      key: `key-${i % keys}`,
      value: { status: ['open', 'assigned', 'resolved'][i % 3], seq: i },
      deleted: false,
      actor,
      counter,
      timestamp: 1_000_000 + i,
    });
  }
  return ops;
}

/** Digest a replica the way the server does: a Map of visible entries. */
export function digestOf(doc) {
  return stateDigest(new Map(doc.values()));
}

export function createFakeServer(ops, hooks = {}) {
  const expected = new LwwElementSet('expected-server', 'local');
  expected.merge(ops);
  const digest = { highwater: sumVector(expected.clock), hash: digestOf(expected) };
  const calls = [];

  const respond = (payload) => ({
    ok: true,
    status: 200,
    // Round-trip through JSON so the client sees exactly what the wire carries.
    json: async () => JSON.parse(JSON.stringify(payload)),
  });

  const fetcher = async (url) => {
    const parsed = new URL(url, 'http://fake.local');
    calls.push({ path: parsed.pathname, since: parsed.searchParams.get('since_vector') });

    if (parsed.pathname === '/api/dispatch') return respond([]);

    if (parsed.pathname === '/api/sync/snapshot') {
      // Cold-start base: empty, so the whole history arrives as deltas.
      let payload = { snapshot_id: 'snap-fake', vector: {}, operations: [], checksum: sha('[]') };
      if (hooks.mutateSnapshot) payload = hooks.mutateSnapshot(payload);
      return respond(payload);
    }

    if (parsed.pathname === '/api/sync/deltas') {
      const since = JSON.parse(parsed.searchParams.get('since_vector') ?? '{}');
      const limit = Number(parsed.searchParams.get('limit') ?? 500);
      const ordered = ops.filter((op) => op.counter > (since[op.actor] ?? 0)).sort(compareForPaging);
      const page = cutPage(ordered, limit);
      const next_vector = { ...since };
      for (const op of page) next_vector[op.actor] = Math.max(next_vector[op.actor] ?? 0, op.counter);
      let payload = {
        operations: page,
        deltas: page,
        next_vector,
        has_more: page.length < ordered.length,
        total_remaining: ordered.length - page.length,
        checksum: sha(JSON.stringify(page)),
      };
      if (hooks.mutateDelta) payload = hooks.mutateDelta(payload, calls.length);
      return respond(payload);
    }

    if (parsed.pathname === '/api/sync/digest') {
      return respond(hooks.digest ? hooks.digest(digest) : digest);
    }

    return { ok: false, status: 404, json: async () => ({}) };
  };

  return { fetcher, calls, digest };
}

/** Wraps a fetcher so the n-th deltas request fails as if the connection dropped. */
export function dropConnectionOn(inner, failingDeltasCall) {
  let deltasCalls = 0;
  return async (url, opts) => {
    if (url.includes('/sync/deltas') && ++deltasCalls === failingDeltasCall) {
      throw new Error('connection dropped');
    }
    return inner(url, opts);
  };
}
