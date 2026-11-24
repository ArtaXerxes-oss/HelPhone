// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import {
  projectDispatchBatch,
  getIndexerCheckpoint,
} from '../server/indexer/exporter.js';
import {
  detectClockGap,
  resetGapDetector,
  getIndexerGaps,
  getUnresolvedGaps,
  resolveGap,
} from '../server/indexer/parser.js';

class MockDbClient {
  constructor() {
    this.rows = new Map();
    this.checkpoint = { last_lsn: '0/0', last_seq: 0, updated_at: new Date().toISOString() };
    this.inTransaction = false;
    this.queryLog = [];
  }

  async query(sql, params = []) {
    this.queryLog.push(sql);
    if (/BEGIN/i.test(sql)) {
      this.inTransaction = true;
      return { rows: [] };
    }
    if (/COMMIT/i.test(sql)) {
      this.inTransaction = false;
      return { rows: [] };
    }
    if (/ROLLBACK/i.test(sql)) {
      this.inTransaction = false;
      return { rows: [] };
    }
    if (/pg_advisory_xact_lock/i.test(sql)) {
      return { rows: [{ pg_advisory_xact_lock: null }] };
    }
    if (/INSERT INTO dispatch_log/i.test(sql)) {
      const [op_id, doc_id, client_id, clock, server_seq, device_id, seq, status, team, payload] = params;
      const key = `${doc_id}:${client_id}:${clock}`;
      if (this.rows.has(key)) {
        // ON CONFLICT DO NOTHING
        return { rows: [] };
      }
      const record = {
        id: this.rows.size + 1,
        op_id,
        doc_id,
        client_id,
        clock,
        server_seq: server_seq || this.rows.size + 1,
        device_id,
        seq,
        status,
        team,
        payload,
      };
      this.rows.set(key, record);
      return { rows: [record] };
    }
    if (/INSERT INTO indexer_checkpoint/i.test(sql)) {
      const [last_lsn, last_seq] = params;
      this.checkpoint = { last_lsn, last_seq, updated_at: new Date().toISOString() };
      return { rows: [this.checkpoint] };
    }
    if (/SELECT last_lsn, last_seq/i.test(sql)) {
      return { rows: [this.checkpoint] };
    }
    return { rows: [] };
  }
}

describe('Indexer Exactly-Once Projection & Gap Detection (ISP-065)', () => {
  beforeEach(() => {
    resetGapDetector();
  });

  it('projects batches transactionally and updates checkpoint in the same transaction', async () => {
    const db = new MockDbClient();
    const ops = [
      { op_id: 'op-1', doc_id: 'doc-A', client_id: 'c1', clock: 1, status: 'en-route' },
      { op_id: 'op-2', doc_id: 'doc-A', client_id: 'c1', clock: 2, status: 'delivered' },
    ];

    const result = await projectDispatchBatch(db, ops, { lsn: '0/16B3000', seq: 2 });
    expect(result.projectedCount).toBe(2);
    expect(result.duplicateCount).toBe(0);

    const cp = await getIndexerCheckpoint(db);
    expect(cp?.last_lsn).toBe('0/16B3000');
    expect(cp?.last_seq).toBe(2);
    expect(db.rows.size).toBe(2);
  });

  it('deduplicates replayed batches without double-applying rows (ON CONFLICT DO NOTHING)', async () => {
    const db = new MockDbClient();
    const batch = [
      { op_id: 'op-1', doc_id: 'doc-A', client_id: 'c1', clock: 1 },
      { op_id: 'op-2', doc_id: 'doc-A', client_id: 'c1', clock: 2 },
    ];

    // First run
    const res1 = await projectDispatchBatch(db, batch, { lsn: '0/100', seq: 2 });
    expect(res1.projectedCount).toBe(2);
    expect(res1.duplicateCount).toBe(0);

    // Simulated restart and replay of the same batch
    const res2 = await projectDispatchBatch(db, batch, { lsn: '0/100', seq: 2 });
    expect(res2.projectedCount).toBe(0);
    expect(res2.duplicateCount).toBe(2);
    expect(db.rows.size).toBe(2);
  });

  it('survives triple-restart replay drill with zero duplicates and zero missing ops', async () => {
    const db = new MockDbClient();
    const batch1 = [
      { op_id: 'op-1', doc_id: 'doc-1', client_id: 'c1', clock: 1 },
      { op_id: 'op-2', doc_id: 'doc-1', client_id: 'c1', clock: 2 },
    ];
    const batch2 = [
      { op_id: 'op-2', doc_id: 'doc-1', client_id: 'c1', clock: 2 }, // overlaps
      { op_id: 'op-3', doc_id: 'doc-1', client_id: 'c1', clock: 3 },
    ];
    const batch3 = [
      { op_id: 'op-3', doc_id: 'doc-1', client_id: 'c1', clock: 3 }, // overlaps
      { op_id: 'op-4', doc_id: 'doc-1', client_id: 'c1', clock: 4 },
    ];

    await projectDispatchBatch(db, batch1, { lsn: '0/10', seq: 2 });
    // Crash 1: Restart and re-project with overlapping batch2
    await projectDispatchBatch(db, batch2, { lsn: '0/20', seq: 3 });
    // Crash 2: Restart and re-project with overlapping batch3
    await projectDispatchBatch(db, batch3, { lsn: '0/30', seq: 4 });

    // Assert exactly 4 unique ops exist
    expect(db.rows.size).toBe(4);
    const cp = await getIndexerCheckpoint(db);
    expect(cp?.last_lsn).toBe('0/30');
    expect(cp?.last_seq).toBe(4);
  });

  it('detects clock gaps and logs missing sequences for backfill', () => {
    // Continuous sequence
    expect(detectClockGap('doc-1', 'client-1', 1).hasGap).toBe(false);
    expect(detectClockGap('doc-1', 'client-1', 2).hasGap).toBe(false);

    // Gap: jumps from 2 to 5 (missing 3 and 4)
    const gapCheck = detectClockGap('doc-1', 'client-1', 5);
    expect(gapCheck.hasGap).toBe(true);
    expect(gapCheck.expectedClock).toBe(3);
    expect(gapCheck.gap?.gap_size).toBe(2);

    const gaps = getIndexerGaps();
    expect(gaps.length).toBe(1);
    expect(gaps[0].expected_clock).toBe(3);
    expect(gaps[0].received_clock).toBe(5);
    expect(getUnresolvedGaps().length).toBe(1);

    // Resolve gap upon backfill receipt
    const resolved = resolveGap('doc-1', 'client-1', 3);
    expect(resolved).toBe(true);
    expect(getUnresolvedGaps().length).toBe(0);
  });
});
