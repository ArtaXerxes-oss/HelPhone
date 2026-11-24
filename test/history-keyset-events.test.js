// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import historyRouter, {
  recordHistoryEvent,
  clearHistoryEvents,
  compareHistoryKey,
} from '../server/routes/history.js';
import {
  setMockReplicationLag,
  setMockAsOfLsn,
  classifyReplicaLag,
  getPool,
} from '../server/db/connection.js';

function seed(count) {
  // Insert in reverse so the test fails if reads depend on insertion order.
  for (let i = count; i >= 1; i--) {
    recordHistoryEvent({
      id: `evt-${String(i).padStart(4, '0')}`,
      server_seq: i,
      eventType: i % 2 === 0 ? 'created' : 'resolved',
      requestId: `req-${i}`,
      timestamp: 1700000000000 + i * 1000,
      raw: { topics: [], data: {} },
    });
  }
}

describe('Keyset history paging and replica lag tiers (ISP-065 / #935)', () => {
  let app;

  beforeEach(() => {
    clearHistoryEvents();
    setMockReplicationLag(100);
    setMockAsOfLsn('0/16C0000');
    app = express();
    app.use(express.json());
    app.use('/api/history', historyRouter);
  });

  afterEach(() => {
    setMockReplicationLag(null);
    setMockAsOfLsn(null);
  });

  it('classifies replay lag into the ISP-065 tiers at the documented boundaries', () => {
    expect(classifyReplicaLag(0)).toBe('normal');
    expect(classifyReplicaLag(10_000)).toBe('normal');
    expect(classifyReplicaLag(10_001)).toBe('lagging');
    expect(classifyReplicaLag(30_000)).toBe('lagging');
    expect(classifyReplicaLag(30_001)).toBe('severe');
  });

  it('pages /api/history/events by keyset cursor with no skips or repeats, and clears X-Next-Cursor on the last page', async () => {
    seed(120);

    const seen = [];
    let cursor = null;
    let pages = 0;
    let lastHeader = null;
    while (pages < 10) {
      const url = cursor ? `/api/history/events?limit=50&cursor=${cursor}` : '/api/history/events?limit=50';
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      pages++;
      seen.push(...res.body.events.map((e) => e.server_seq));
      lastHeader = res.headers['x-next-cursor'];
      expect(typeof lastHeader).toBe('string');
      if (!lastHeader) {
        expect(res.body.pagination.hasMore).toBe(false);
        expect(res.body.pagination.nextCursor).toBeNull();
        break;
      }
      expect(res.body.pagination.hasMore).toBe(true);
      cursor = lastHeader;
    }

    expect(pages).toBe(3);
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    expect(lastHeader).toBe('');
  });

  it('ignores the legacy page offset and returns the first keyset page', async () => {
    seed(60);
    const res = await request(app).get('/api/history/events?page=1&limit=50');
    expect(res.status).toBe(200);
    expect(res.body.events[0].server_seq).toBe(1);
    expect(res.body.events).toHaveLength(50);
    expect(res.body.pagination.total).toBe(60);
  });

  it('rejects a malformed cursor with 400 instead of silently restarting at the first page', async () => {
    seed(3);
    const list = await request(app).get('/api/history?cursor=%%%');
    expect(list.status).toBe(400);
    const events = await request(app).get('/api/history/events?cursor=bm9wZQ');
    expect(events.status).toBe(400);
  });

  it('sets X-Next-Cursor on every /api/history response, empty when there is no next page', async () => {
    seed(3);
    const first = await request(app).get('/api/history?limit=2');
    expect(first.status).toBe(200);
    expect(first.headers['x-next-cursor']).toBeTruthy();

    const second = await request(app).get(`/api/history?limit=2&cursor=${first.headers['x-next-cursor']}`);
    expect(second.status).toBe(200);
    expect(second.body).toHaveLength(1);
    expect(second.headers['x-next-cursor']).toBe('');
  });

  it('returns 209 with tier "severe" when lag is above 30s and the primary reserve is exhausted', async () => {
    setMockReplicationLag(45_000);
    const pool = getPool();
    const held = [];
    for (let i = 0; i < 5; i++) held.push(await pool.acquirePrimaryReserve());
    try {
      const res = await request(app).get('/api/history/events');
      expect(res.status).toBe(209);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body.tier).toBe('severe');
      expect(res.body.stale).toBe(true);
    } finally {
      for (const client of held) pool.releasePrimaryReserve(client);
    }
  });

  it('orders by (server_seq, id) with one comparator for sort and cursor', () => {
    const rows = [
      { server_seq: 2, id: 'b' },
      { server_seq: 1, id: 'z' },
      { server_seq: 2, id: 'a' },
    ];
    rows.sort(compareHistoryKey);
    expect(rows.map((r) => `${r.server_seq}:${r.id}`)).toEqual(['1:z', '2:a', '2:b']);
  });
});
