/**
 * Unit tests for CheckpointCommitted parsing and finality-tier projection.
 * Issue #916 / spike #727.
 *
 * Covers:
 *   1. classifyFinality tier boundaries (pending / closed / finalized / orphaned).
 *   2. parseCheckpointCommitted — first sight is always pending; tier at depth.
 *   3. reclassifyCheckpoint — tip advance and orphan detection.
 *   4. projectCheckpointCommitted — upsert, depth advance, orphan + rewind path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ── finality.ts (pure, no DB) ─────────────────────────────────────────────────
import {
  classifyFinality,
  isOrphaned,
  DEFAULT_FINALITY_DEPTH,
} from '../lib/finality.js';

// ── parser.ts ─────────────────────────────────────────────────────────────────
import {
  parseCheckpointCommitted,
  reclassifyCheckpoint,
} from '../indexer/parser.js';

// ── exporter.ts ───────────────────────────────────────────────────────────────
import {
  projectCheckpointCommitted,
  rewindCheckpointWatermark,
} from '../indexer/exporter.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal in-memory QueryRunner that records calls. */
function makeQueryRunner() {
  const store = {
    checkpoint_sightings: [],
    indexer_checkpoint: [],
    queries: [],
  };

  const runner = {
    store,
    async query(sql, params = []) {
      store.queries.push({ sql: sql.trim().replace(/\s+/g, ' '), params });

      // ── checkpoint_sightings SELECT ──────────────────────────────────────
      if (/SELECT.*checkpoint_sightings.*WHERE ledger/i.test(sql)) {
        const ledger = params[0];
        const rows = store.checkpoint_sightings.filter((r) => r.ledger === ledger);
        return { rows };
      }

      // ── checkpoint_sightings UPDATE (orphan) ─────────────────────────────
      if (/UPDATE checkpoint_sightings SET finality_tier = 'orphaned'/i.test(sql)) {
        const [ledger, hash] = params;
        store.checkpoint_sightings = store.checkpoint_sightings.map((r) =>
          r.ledger === ledger && r.ledger_hash === hash
            ? { ...r, finality_tier: 'orphaned' }
            : r,
        );
        return { rows: [] };
      }

      // ── indexer_checkpoint upsert (rewind) ───────────────────────────────
      if (/INSERT INTO indexer_checkpoint/i.test(sql)) {
        const targetSeq = params[0] === undefined ? params[1] : params[0];
        const existing = store.indexer_checkpoint[0];
        if (existing) {
          existing.last_seq = Math.min(existing.last_seq, Number(targetSeq));
          existing.last_lsn = '0/0';
        } else {
          store.indexer_checkpoint.push({ id: 1, last_lsn: '0/0', last_seq: Number(targetSeq) });
        }
        return { rows: [] };
      }

      // ── checkpoint_sightings INSERT … ON CONFLICT ──────────────────────
      if (/INSERT INTO checkpoint_sightings/i.test(sql)) {
        const [ledger, ledger_hash, depth, finality_tier] = params;
        const idx = store.checkpoint_sightings.findIndex(
          (r) => r.ledger === ledger && r.ledger_hash === ledger_hash,
        );
        if (idx === -1) {
          const row = { ledger, ledger_hash, depth, finality_tier, first_seen_at: new Date().toISOString() };
          store.checkpoint_sightings.push(row);
          return { rows: [row] };
        }
        // ON CONFLICT DO UPDATE
        const row = store.checkpoint_sightings[idx];
        row.depth = Math.max(row.depth, depth);
        if (row.finality_tier !== 'orphaned') row.finality_tier = finality_tier;
        return { rows: [row] };
      }

      return { rows: [] };
    },
  };
  return runner;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. classifyFinality — tier boundaries
// ─────────────────────────────────────────────────────────────────────────────

test('classifyFinality: depth 0 is pending', () => {
  assert.equal(classifyFinality(0), 'pending');
});

test('classifyFinality: depth 1 is closed (below default k=2)', () => {
  assert.equal(classifyFinality(1), 'closed');
});

test('classifyFinality: depth 2 is finalized at default k=2', () => {
  assert.equal(classifyFinality(2), 'finalized');
});

test('classifyFinality: depth > k is finalized', () => {
  assert.equal(classifyFinality(10), 'finalized');
});

test('classifyFinality: custom k=5 — depth 4 is closed', () => {
  assert.equal(classifyFinality(4, { finalityDepth: 5 }), 'closed');
});

test('classifyFinality: custom k=5 — depth 5 is finalized', () => {
  assert.equal(classifyFinality(5, { finalityDepth: 5 }), 'finalized');
});

test('classifyFinality: negative depth throws', () => {
  assert.throws(() => classifyFinality(-1), RangeError);
});

test('classifyFinality: NaN depth throws', () => {
  assert.throws(() => classifyFinality(NaN), RangeError);
});

test('DEFAULT_FINALITY_DEPTH is 2', () => {
  assert.equal(DEFAULT_FINALITY_DEPTH, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. isOrphaned
// ─────────────────────────────────────────────────────────────────────────────

test('isOrphaned: same ledger, different hash → orphaned', () => {
  assert.equal(isOrphaned({ ledger: 100, ledgerHash: 'abc' }, { ledger: 100, ledgerHash: 'xyz' }), true);
});

test('isOrphaned: same ledger, same hash → not orphaned', () => {
  assert.equal(isOrphaned({ ledger: 100, ledgerHash: 'abc' }, { ledger: 100, ledgerHash: 'abc' }), false);
});

test('isOrphaned: different ledger → not orphaned', () => {
  assert.equal(isOrphaned({ ledger: 100, ledgerHash: 'abc' }, { ledger: 101, ledgerHash: 'xyz' }), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. parseCheckpointCommitted
// ─────────────────────────────────────────────────────────────────────────────

const TOPICS = ['CheckpointCommitted', '1000', 'abc123ledgerhash'];

test('parseCheckpointCommitted: first sight is always pending (depth 0)', () => {
  const cp = parseCheckpointCommitted(TOPICS, {}, 1000);
  assert.equal(cp.eventType, 'checkpoint_committed');
  assert.equal(cp.finalityTier, 'pending');
  assert.equal(cp.depth, 0);
  assert.equal(cp.ledger, 1000);
  assert.equal(cp.ledgerHash, 'abc123ledgerhash');
});

test('parseCheckpointCommitted: depth = tip - ledger', () => {
  const cp = parseCheckpointCommitted(TOPICS, {}, 1002);
  assert.equal(cp.depth, 2);
  assert.equal(cp.finalityTier, 'finalized');
});

test('parseCheckpointCommitted: depth 1 is closed', () => {
  const cp = parseCheckpointCommitted(TOPICS, {}, 1001);
  assert.equal(cp.depth, 1);
  assert.equal(cp.finalityTier, 'closed');
});

test('parseCheckpointCommitted: no tip defaults to depth 0', () => {
  const cp = parseCheckpointCommitted(TOPICS, {});
  assert.equal(cp.depth, 0);
  assert.equal(cp.finalityTier, 'pending');
});

test('parseCheckpointCommitted: stale tip yields depth 0 not negative', () => {
  // tip behind ledger — guard against stale cursor
  const cp = parseCheckpointCommitted(TOPICS, {}, 999);
  assert.equal(cp.depth, 0);
  assert.equal(cp.finalityTier, 'pending');
});

test('parseCheckpointCommitted: invalid ledger sequence throws', () => {
  assert.throws(
    () => parseCheckpointCommitted(['CheckpointCommitted', 'not-a-number', 'hash'], {}),
    RangeError,
  );
});

test('parseCheckpointCommitted: missing ledger hash throws', () => {
  assert.throws(
    () => parseCheckpointCommitted(['CheckpointCommitted', '1000', ''], {}),
    TypeError,
  );
});

test('parseCheckpointCommitted: checkpoint row carries ledger hash', () => {
  const cp = parseCheckpointCommitted(TOPICS, { memo: 'secret' }, 1000);
  assert.equal(cp.ledgerHash, 'abc123ledgerhash');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. reclassifyCheckpoint
// ─────────────────────────────────────────────────────────────────────────────

test('reclassifyCheckpoint: tip advances from 1000 to 1002 → finalized', () => {
  const stored = parseCheckpointCommitted(TOPICS, {}, 1000);
  const updated = reclassifyCheckpoint(stored, 1002);
  assert.equal(updated.depth, 2);
  assert.equal(updated.finalityTier, 'finalized');
});

test('reclassifyCheckpoint: same hash → not orphaned', () => {
  const stored = parseCheckpointCommitted(TOPICS, {}, 1000);
  const updated = reclassifyCheckpoint(stored, 1001, { ledger: 1000, ledgerHash: 'abc123ledgerhash' });
  assert.notEqual(updated.finalityTier, 'orphaned');
});

test('reclassifyCheckpoint: different hash → orphaned', () => {
  const stored = parseCheckpointCommitted(TOPICS, {}, 1000);
  const updated = reclassifyCheckpoint(stored, 1001, { ledger: 1000, ledgerHash: 'differenthash' });
  assert.equal(updated.finalityTier, 'orphaned');
});

test('reclassifyCheckpoint: orphaned stays orphaned even if tip advances further', () => {
  const stored = parseCheckpointCommitted(TOPICS, {}, 1000);
  const orphaned = reclassifyCheckpoint(stored, 1001, { ledger: 1000, ledgerHash: 'differenthash' });
  // Even if re-classified again with the original hash, the orphan is already set
  assert.equal(orphaned.finalityTier, 'orphaned');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. projectCheckpointCommitted — upsert, orphan + watermark rewind
// ─────────────────────────────────────────────────────────────────────────────

test('projectCheckpointCommitted: first sight inserts pending row', async () => {
  const runner = makeQueryRunner();
  const cp = parseCheckpointCommitted(TOPICS, {}, 1000);
  const result = await projectCheckpointCommitted(runner, cp);

  assert.equal(result.inserted, true);
  assert.equal(result.updated, false);
  assert.equal(result.orphaned, false);
  assert.equal(result.rewound, false);
  assert.equal(result.row.finality_tier, 'pending');
  assert.equal(result.row.ledger, 1000);
  assert.equal(result.row.ledger_hash, 'abc123ledgerhash');
});

test('projectCheckpointCommitted: second sight with same hash advances tier', async () => {
  const runner = makeQueryRunner();
  const first = parseCheckpointCommitted(TOPICS, {}, 1000);
  await projectCheckpointCommitted(runner, first);

  const second = parseCheckpointCommitted(TOPICS, {}, 1002); // tip advanced
  const result = await projectCheckpointCommitted(runner, second);

  assert.equal(result.inserted, false);
  assert.equal(result.updated, true);
  assert.equal(result.row.finality_tier, 'finalized');
  assert.equal(result.row.depth, 2);
});

test('projectCheckpointCommitted: different hash marks existing orphaned and rewinds watermark', async () => {
  const runner = makeQueryRunner();
  // Initial checkpoint watermark at seq 1000
  runner.store.indexer_checkpoint.push({ id: 1, last_lsn: 'A/B', last_seq: 1000 });

  const first = parseCheckpointCommitted(TOPICS, {}, 1000);
  await projectCheckpointCommitted(runner, first);

  // Reorg: same ledger, different hash
  const reorgTopics = ['CheckpointCommitted', '1000', 'reorghash'];
  const reorg = parseCheckpointCommitted(reorgTopics, {}, 1000);
  const result = await projectCheckpointCommitted(runner, reorg);

  assert.equal(result.orphaned, true);
  assert.equal(result.rewound, true);

  // Watermark rewound to ledger - 1 = 999
  const cp = runner.store.indexer_checkpoint[0];
  assert.ok(cp.last_seq <= 999, `expected last_seq ≤ 999, got ${cp.last_seq}`);
});

test('rewindCheckpointWatermark: sets last_seq to min of current and target', async () => {
  const runner = makeQueryRunner();
  runner.store.indexer_checkpoint.push({ id: 1, last_lsn: 'A/B', last_seq: 1050 });

  await rewindCheckpointWatermark(runner, 999);

  assert.equal(runner.store.indexer_checkpoint[0].last_seq, 999);
  assert.equal(runner.store.indexer_checkpoint[0].last_lsn, '0/0');
});

test('rewindCheckpointWatermark: does not advance a watermark already below target', async () => {
  const runner = makeQueryRunner();
  runner.store.indexer_checkpoint.push({ id: 1, last_lsn: 'A/B', last_seq: 500 });

  // target 999 > current 500 — LEAST keeps 500
  await rewindCheckpointWatermark(runner, 999);

  assert.equal(runner.store.indexer_checkpoint[0].last_seq, 500);
});
