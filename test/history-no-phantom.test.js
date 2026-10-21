// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import historyRouter, {
  recordHistoryEvent,
  clearHistoryEvents,
  encodeCursor,
  decodeCursor,
} from '../server/routes/history.js';
import {
  setMockReplicationLag,
  setMockAsOfLsn,
  getHistoryConn,
  getPool,
} from '../server/db/connection.js';
import { runMaintenance, __resetMaintenanceState } from '../server/db/maintenance.js';
import { runMigrations } from '../server/db/migrator.js';

describe('Lag-Tolerant History & Replication Routing (ISP-065)', () => {
  let app;

  beforeEach(() => {
    clearHistoryEvents();
    setMockReplicationLag(null);
    setMockAsOfLsn(null);
    __resetMaintenanceState();

    app = express();
    app.use(express.json());
    app.use('/api/history', historyRouter);
  });

  afterEach(() => {
    setMockReplicationLag(null);
    setMockAsOfLsn(null);
  });

  it('routes to replica when replication lag <= 10s', async () => {
    setMockReplicationLag(2500); // 2.5s lag
    setMockAsOfLsn('0/16B3000');

    const conn = await getHistoryConn(10000);
    expect(conn.isReplica).toBe(true);
    expect(conn.isReserve).toBe(false);
    expect(conn.isStale).toBe(false);
    expect(conn.lagMs).toBe(2500);
    expect(conn.asOfLsn).toBe('0/16B3000');
    conn.release();
  });

  it('routes to primary reserve when replication lag > 10s', async () => {
    setMockReplicationLag(15000); // 15s lag (exceeds 10s budget)
    setMockAsOfLsn('0/16B4000');

    const conn = await getHistoryConn(10000);
    expect(conn.isReplica).toBe(false);
    expect(conn.isReserve).toBe(true);
    expect(conn.isStale).toBe(false);
    expect(conn.lagMs).toBe(15000);
    conn.release();
  });

  it('emits X-Replica-Lag-Ms and X-As-Of-LSN headers on every history response', async () => {
    setMockReplicationLag(1200);
    setMockAsOfLsn('0/16B5000');

    recordHistoryEvent({
      eventType: 'created',
      requestId: 'req-1',
      timestamp: Date.now(),
      raw: { topics: [], data: {} },
    });

    const res = await request(app).get('/api/history?limit=10');
    expect(res.status).toBe(200);
    expect(res.headers['x-replica-lag-ms']).toBe('1200');
    expect(res.headers['x-as-of-lsn']).toBe('0/16B5000');
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
  });

  it('returns HTTP 209 Stale with Retry-After when replication lag > 10s and reserve exhausted', async () => {
    setMockReplicationLag(35000); // 35s lag
    setMockAsOfLsn('0/16B6000');

    const pool = getPool();
    // Exhaust all 5 primary reserve slots
    const reservedClients = [];
    for (let i = 0; i < 5; i++) {
      reservedClients.push(await pool.acquirePrimaryReserve());
    }

    try {
      const res = await request(app).get('/api/history?limit=10');
      expect(res.status).toBe(209);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.headers['x-replica-lag-ms']).toBe('35000');
      expect(res.body.stale).toBe(true);
    } finally {
      for (const client of reservedClients) {
        pool.releasePrimaryReserve(client);
      }
    }
  });

  it('paginates over 500 rows using keyset cursor without skips or duplicates', async () => {
    setMockReplicationLag(100);
    setMockAsOfLsn('0/16B7000');

    // Populate 500 records
    for (let i = 1; i <= 500; i++) {
      recordHistoryEvent({
        id: `event-${i.toString().padStart(4, '0')}`,
        server_seq: i,
        eventType: i % 2 === 0 ? 'created' : 'resolved',
        requestId: `req-${i}`,
        timestamp: 1700000000000 + i * 1000,
        raw: { topics: [], data: {} },
      });
    }

    const pageSize = 100;
    const collectedIds = new Set();
    let cursor = null;
    let pageCount = 0;

    while (true) {
      const url = cursor
        ? `/api/history?limit=${pageSize}&cursor=${cursor}`
        : `/api/history?limit=${pageSize}`;

      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      const rows = res.body;
      if (!rows || rows.length === 0) break;

      pageCount++;
      for (const row of rows) {
        expect(collectedIds.has(row.id)).toBe(false); // No duplicates!
        collectedIds.add(row.id);
      }

      cursor = res.headers['x-next-cursor'] || null;
      if (!cursor) break;
    }

    expect(pageCount).toBe(5);
    expect(collectedIds.size).toBe(500); // Zero skips!
  });

  it('pauses database maintenance when replication lag > 30s', async () => {
    setMockReplicationLag(35000); // 35s lag
    const report = await runMaintenance({
      now: () => new Date(Date.UTC(2026, 8, 24, 3, 30)), // Inside maintenance window
      config: {
        enabled: true,
        bloatThresholdPct: 20,
        windowStartHour: 2,
        windowEndHour: 5,
        intervalMs: 60_000,
        reindexCooldownMs: 1000,
        minTableTuples: 0,
      },
      query: async () => ({ rows: [] }),
    });

    expect(report.skipped).toBe('replication-lag');
    expect(report.tables).toEqual([]);
  });

  it('refuses non-urgent schema migrations when replication lag > 15s', async () => {
    setMockReplicationLag(20000); // 20s lag
    const report = await runMigrations({
      runner: {
        name: 'test-runner',
        query: async (sql) => {
          if (/to_regclass/i.test(sql)) return { rows: [{ present: 'schema_migrations' }] };
          return { rows: [] };
        },
      },
    });

    expect(report.reason).toBe('replication-lag');
    expect(report.error).toContain('Replication lag exceeds 15s threshold');
  });

  it('sheds and buffers telemetry bulk writes under high lag', () => {
    const pool = getPool();
    expect(pool.getTelemetryBuffer().length).toBe(0);

    pool.shedTelemetryBatch({ batchId: 1, records: [1, 2, 3] });
    pool.shedTelemetryBatch({ batchId: 2, records: [4, 5] });

    expect(pool.getTelemetryBuffer().length).toBe(2);

    const drained = pool.drainTelemetryBuffer();
    expect(drained.length).toBe(2);
    expect(pool.getTelemetryBuffer().length).toBe(0);
  });
});
