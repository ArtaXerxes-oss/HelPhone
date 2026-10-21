// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { hydratePaged } from '../src/services/crdtSync.js';
import { LwwElementSet } from '../src/lib/crdt.js';
import { handleRoutingMessage, createRoutingState } from '../src/workers/routingWorker.js';
import { createJoinReceipt, verifyJoinCompleteness } from '../server/indexer/auditStreamer.js';

class MockStorage {
  constructor() {
    this.map = new Map();
  }
  async getItem(key) {
    return this.map.get(key) ?? null;
  }
  async setItem(key, val) {
    this.map.set(key, String(val));
  }
  async removeItem(key) {
    this.map.delete(key);
  }
}

describe('CRDT Paged Dehydration & Actionable-First Protocol (ISP-066)', () => {
  let doc;
  let storage;

  beforeEach(() => {
    doc = new LwwElementSet('client-joiner', 'local');
    storage = new MockStorage();
  });

  it('fetches actionable slice first (<1MB) before background deltas', async () => {
    const fetchCalls = [];
    const mockFetcher = async (url) => {
      fetchCalls.push(url);
      if (url.includes('slice=open-today')) {
        return {
          ok: true,
          json: async () => [
            { id: 'disp-1', status: 'open', geohash: 'u4pruydqqvj' },
            { id: 'disp-2', status: 'assigned', geohash: 'u4pruydqqvk' },
          ],
        };
      }
      if (url.includes('/sync/snapshot')) {
        return {
          ok: true,
          json: async () => ({
            snapshot_id: 'snap-1',
            vector: { peerA: 10 },
            operations: [{ key: 'k1', value: 'v1', actor: 'peerA', counter: 10, deleted: false, timestamp: 100 }],
          }),
        };
      }
      if (url.includes('/sync/deltas')) {
        return {
          ok: true,
          json: async () => ({
            deltas: [],
            next_vector: { peerA: 10 },
            has_more: false,
            checksum: 'abc',
          }),
        };
      }
      return { ok: false, status: 404 };
    };

    const progressPhases = [];
    const result = await hydratePaged({
      doc,
      storage,
      fetcher: mockFetcher,
      onProgress: (p) => progressPhases.push(p.phase),
    });

    // Actionable was fetched first!
    expect(fetchCalls[0]).toContain('slice=open-today');
    expect(result.actionable.length).toBe(2);
    expect(progressPhases).toContain('actionable');
    expect(progressPhases).toContain('actionable_ready');
    expect(progressPhases).toContain('complete');
  });

  it('paginates deltas in 500-op pages with state-vector checkpoints', async () => {
    let callCount = 0;
    const mockFetcher = async (url) => {
      if (url.includes('slice=open-today')) {
        return { ok: true, json: async () => [] };
      }
      if (url.includes('/sync/deltas')) {
        callCount++;
        if (callCount === 1) {
          const ops = Array.from({ length: 500 }, (_, i) => ({
            key: `key-${i + 1}`,
            value: `val-${i + 1}`,
            actor: 'peerA',
            counter: i + 1,
            deleted: false,
            timestamp: 1000 + i,
          }));
          return {
            ok: true,
            json: async () => ({
              deltas: ops,
              next_vector: { peerA: 500 },
              has_more: true,
              checksum: 'page-1-hash',
            }),
          };
        }
        if (callCount === 2) {
          const ops = Array.from({ length: 300 }, (_, i) => ({
            key: `key-${i + 501}`,
            value: `val-${i + 501}`,
            actor: 'peerA',
            counter: i + 501,
            deleted: false,
            timestamp: 2000 + i,
          }));
          return {
            ok: true,
            json: async () => ({
              deltas: ops,
              next_vector: { peerA: 800 },
              has_more: false,
              checksum: 'page-2-hash',
            }),
          };
        }
      }
      return { ok: false, status: 404 };
    };

    // Pre-seed storage vector so it skips cold snapshot
    await storage.setItem('crdt_resume_vector', JSON.stringify({ peerA: 0 }));

    const result = await hydratePaged({
      doc,
      storage,
      fetcher: mockFetcher,
      pageSize: 500,
    });

    expect(result.pagesApplied).toBe(2);
    expect(result.totalOps).toBe(800);
    expect(result.vector.peerA).toBe(800);

    // Vector was checkpointed in storage!
    const savedVector = JSON.parse(await storage.getItem('crdt_resume_vector'));
    expect(savedVector.peerA).toBe(800);
  });

  it('resumes interrupted join from checkpointed vector without restarting from zero', async () => {
    // Interrupted state: already at counter 500
    await storage.setItem('crdt_resume_vector', JSON.stringify({ peerA: 500 }));

    const requestedSinceVectors = [];
    const mockFetcher = async (url) => {
      if (url.includes('slice=open-today')) return { ok: true, json: async () => [] };
      if (url.includes('/sync/deltas')) {
        const parsedUrl = new URL(url, 'http://localhost');
        const since = parsedUrl.searchParams.get('since_vector');
        requestedSinceVectors.push(JSON.parse(decodeURIComponent(since)));

        return {
          ok: true,
          json: async () => ({
            deltas: [
              { key: 'key-501', value: 'val-501', actor: 'peerA', counter: 501, deleted: false, timestamp: 3000 },
            ],
            next_vector: { peerA: 501 },
            has_more: false,
            checksum: 'resumed-hash',
          }),
        };
      }
      return { ok: false, status: 404 };
    };

    const result = await hydratePaged({
      doc,
      storage,
      fetcher: mockFetcher,
    });

    expect(requestedSinceVectors[0]).toEqual({ peerA: 500 });
    expect(result.pagesApplied).toBe(1);
    expect(result.totalOps).toBe(1);
    expect(result.vector.peerA).toBe(501);
  });

  it('gates routing worker with history-partial badge until actionable_complete', () => {
    const state = createRoutingState();
    state.graph = {
      nodeCount: 2,
      edgeCount: 1,
      lng: new Float64Array([0, 1]),
      lat: new Float64Array([0, 1]),
    };
    state.actionableComplete = false;

    // Route calculation requested while hydration is partial
    const partialResult = handleRoutingMessage(state, {
      id: 'msg-1',
      type: 'route',
      from: 0,
      to: 1,
    });

    expect(partialResult.reply.badge).toBe('history-partial');
    expect(partialResult.reply.status).toBe('history-partial');
    expect(partialResult.reply.eta).toBeNull();
    expect(partialResult.reply.distance).toBeNull();

    // Mark actionable complete
    handleRoutingMessage(state, {
      id: 'msg-2',
      type: 'setActionableComplete',
      complete: true,
    });
    expect(state.actionableComplete).toBe(true);
  });

  it('verifies completeness receipts and rejects mismatched or partial joins', () => {
    const receipt = createJoinReceipt({
      snapshotId: 'snap-100',
      highwater: 1500,
      pageCount: 3,
      hash: 'expected-hash-123',
    });

    expect(receipt.receiptId).toBeDefined();
    expect(receipt.verified).toBe(false);

    // Mismatched snapshot
    const mismatch = verifyJoinCompleteness(receipt, {
      snapshotId: 'snap-200',
      highwater: 1500,
      hash: 'expected-hash-123',
    });
    expect(mismatch.complete).toBe(false);
    expect(mismatch.reason).toBe('snapshot_mismatch');

    // Partial/behind highwater
    const behind = verifyJoinCompleteness(receipt, {
      snapshotId: 'snap-100',
      highwater: 2000,
      hash: 'expected-hash-123',
    });
    expect(behind.complete).toBe(false);
    expect(behind.reason).toBe('highwater_behind');

    // Matching receipt
    const match = verifyJoinCompleteness(receipt, {
      snapshotId: 'snap-100',
      highwater: 1500,
      hash: 'expected-hash-123',
    });
    expect(match.complete).toBe(true);
    expect(receipt.verified).toBe(true);
  });
});
