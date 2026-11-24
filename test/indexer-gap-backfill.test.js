// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ingestDispatchOps,
  runBackfillPass,
} from '../server/indexer/backfill.js';
import {
  resetGapDetector,
  getUnresolvedGaps,
  seedClockHighWaterMarks,
} from '../server/indexer/parser.js';
import { loadClockHighWaterMarks } from '../server/indexer/exporter.js';

/** Minimal Postgres stand-in covering the statements backfill.ts and exporter.ts issue. */
class MockDb {
  constructor() {
    this.dispatch = new Map();
    this.gaps = [];
    this.nextGapId = 1;
    this.checkpoint = { last_lsn: '0/0', last_seq: 0 };
    this.failNextGapInsert = false;
  }

  async query(sql, params = []) {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [] };
    if (/pg_advisory_xact_lock/i.test(sql)) return { rows: [] };

    if (/INSERT INTO dispatch_log/i.test(sql)) {
      const [op_id, doc_id, client_id, clock, server_seq, device_id, seq, status, team, payload] = params;
      const key = `${doc_id}:${client_id}:${clock}`;
      if (this.dispatch.has(key)) return { rows: [] };
      const row = { op_id, doc_id, client_id, clock: Number(clock), server_seq, device_id, seq, status, team, payload };
      this.dispatch.set(key, row);
      return { rows: [row] };
    }

    if (/INSERT INTO indexer_checkpoint/i.test(sql)) {
      this.checkpoint = { last_lsn: params[0], last_seq: params[1] };
      return { rows: [] };
    }

    if (/SELECT 1 FROM indexer_gap_log/i.test(sql)) {
      const [doc_id, client_id, expected, received] = params;
      const hit = this.gaps.find(
        (g) => !g.resolved && g.doc_id === doc_id && g.client_id === client_id &&
          g.expected_clock === Number(expected) && g.received_clock === Number(received)
      );
      return { rows: hit ? [{ '?column?': 1 }] : [] };
    }

    if (/INSERT INTO indexer_gap_log/i.test(sql)) {
      if (this.failNextGapInsert) {
        this.failNextGapInsert = false;
        throw new Error('connection reset');
      }
      const [doc_id, client_id, expected_clock, received_clock, gap_size, resolved] = params;
      this.gaps.push({
        id: this.nextGapId++, doc_id, client_id,
        expected_clock: Number(expected_clock), received_clock: Number(received_clock),
        gap_size, resolved,
      });
      return { rows: [] };
    }

    if (/FROM indexer_gap_log\s+WHERE resolved = FALSE/i.test(sql)) {
      const limit = params[0];
      return {
        rows: this.gaps
          .filter((g) => !g.resolved)
          .sort((a, b) => a.id - b.id)
          .slice(0, limit)
          .map((g) => ({
            id: g.id, doc_id: g.doc_id, client_id: g.client_id,
            expected_clock: g.expected_clock, received_clock: g.received_clock,
          })),
      };
    }

    if (/UPDATE indexer_gap_log SET resolved = TRUE/i.test(sql)) {
      const gap = this.gaps.find((g) => g.id === Number(params[0]));
      if (gap) gap.resolved = true;
      return { rows: [] };
    }

    if (/SELECT doc_id, client_id, MAX\(clock\)/i.test(sql)) {
      const best = new Map();
      for (const row of this.dispatch.values()) {
        const key = `${row.doc_id}|${row.client_id}`;
        best.set(key, Math.max(best.get(key) ?? 0, row.clock));
      }
      return {
        rows: [...best.entries()].map(([key, max_clock]) => {
          const [doc_id, client_id] = key.split('|');
          return { doc_id, client_id, max_clock };
        }),
      };
    }

    return { rows: [] };
  }

  unresolvedCount() {
    return this.gaps.filter((g) => !g.resolved).length;
  }
}

function op(clock, extra = {}) {
  return { op_id: `op-${clock}`, doc_id: 'doc-A', client_id: 'c1', clock, status: 'en-route', ...extra };
}

describe('Gap-driven backfill for the dispatch indexer (ISP-065 §3 / #935)', () => {
  beforeEach(() => {
    resetGapDetector();
  });

  it('records a forced clock gap and still projects the whole batch', async () => {
    const db = new MockDb();
    const result = await ingestDispatchOps(db, [op(1), op(2), op(5)], { lsn: '0/10', seq: 3 });

    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ expected_clock: 3, received_clock: 5 });
    expect(result.projectedCount).toBe(3);
    expect(db.dispatch.size).toBe(3);
    expect(db.unresolvedCount()).toBe(1);
  });

  it('does not record the same gap twice when the batch is replayed', async () => {
    const db = new MockDb();
    const batch = [op(1), op(2), op(5)];
    await ingestDispatchOps(db, batch, { lsn: '0/10', seq: 3 });
    const replay = await ingestDispatchOps(db, batch, { lsn: '0/10', seq: 3 });

    expect(replay.gaps).toHaveLength(0);
    expect(replay.duplicateCount).toBe(3);
    expect(db.gaps).toHaveLength(1);
  });

  it('a backfill pass resolves the gap once the missing clocks arrive, and leaves the checkpoint alone', async () => {
    const db = new MockDb();
    await ingestDispatchOps(db, [op(1), op(2), op(5)], { lsn: '0/10', seq: 3 });

    const requests = [];
    const result = await runBackfillPass(db, async (req) => {
      requests.push(req);
      return [op(3), op(4)];
    });

    expect(requests).toEqual([{ docId: 'doc-A', clientId: 'c1', fromClock: 3, toClock: 4 }]);
    expect(result).toMatchObject({ checked: 1, resolved: 1, pending: 0, failed: 0 });
    expect(db.unresolvedCount()).toBe(0);
    expect(db.dispatch.size).toBe(5);
    expect(db.checkpoint.last_lsn).toBe('0/10');
    expect(getUnresolvedGaps()).toHaveLength(0);
  });

  it('keeps a gap unresolved when the fetch returns only part of the range', async () => {
    const db = new MockDb();
    await ingestDispatchOps(db, [op(1), op(2), op(5)], { lsn: '0/10', seq: 3 });

    const result = await runBackfillPass(db, async () => [op(3)]);

    expect(result).toMatchObject({ checked: 1, resolved: 0, pending: 1 });
    expect(db.unresolvedCount()).toBe(1);
  });

  it('does not fetch ranges wider than maxRange and reports them as failed', async () => {
    const db = new MockDb();
    await ingestDispatchOps(db, [op(1), op(500)], { lsn: '0/10', seq: 2 });

    let called = false;
    const result = await runBackfillPass(db, async () => {
      called = true;
      return [];
    }, { maxRange: 10 });

    expect(called).toBe(false);
    expect(result).toMatchObject({ checked: 1, failed: 1, resolved: 0 });
    expect(db.unresolvedCount()).toBe(1);
  });

  it('after a failed gap write, the retry detects and records the gap again', async () => {
    const db = new MockDb();
    db.failNextGapInsert = true;

    await expect(ingestDispatchOps(db, [op(1), op(2), op(5)], { lsn: '0/10', seq: 3 })).rejects.toThrow('connection reset');
    expect(db.gaps).toHaveLength(0);

    const retry = await ingestDispatchOps(db, [op(1), op(2), op(5)], { lsn: '0/10', seq: 3 });
    expect(retry.gaps).toHaveLength(1);
    expect(db.gaps).toHaveLength(1);
    expect(db.dispatch.size).toBe(3);
  });

  it('seeding the detector from dispatch_log stops a restart from reporting a false gap', async () => {
    const db = new MockDb();
    await ingestDispatchOps(db, [op(1), op(2), op(3), op(4), op(5)], { lsn: '0/10', seq: 5 });

    // Simulated restart: in-memory detector state is lost.
    resetGapDetector();
    const withoutSeed = await ingestDispatchOps(db, [op(6)], null);
    expect(withoutSeed.gaps).toHaveLength(1);

    resetGapDetector();
    const marks = await loadClockHighWaterMarks(db);
    expect(seedClockHighWaterMarks(marks)).toBe(1);
    const withSeed = await ingestDispatchOps(db, [op(7)], null);
    expect(withSeed.gaps).toHaveLength(0);
  });
});
