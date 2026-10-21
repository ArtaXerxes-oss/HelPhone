// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import {
  reconcileAndResurrect,
  waitForRecovery,
  resetRecoveryGate,
  isRecoveryComplete,
} from '../src/lib/crashRecovery.js';
import { JournalStore } from '../src/lib/secureStorage.js';
import { MemoryBackend } from '../src/services/storageEngine.js';
import { SyncManager } from '../src/lib/syncManager.js';
import { LwwElementSet } from '../src/lib/crdt.js';
import { syncRouter, clearCommittedDeviceSeq } from '../server/routes/sync.js';

class MockMemoryStorage {
  constructor() {
    this.data = new Map();
  }
  getItem(key) {
    return this.data.get(key) ?? null;
  }
  setItem(key, val) {
    this.data.set(key, String(val));
  }
  removeItem(key) {
    this.data.delete(key);
  }
}

describe('Crash-Atomic Triple-Write & Resurrection (ISP-067)', () => {
  let storageEngine;
  let journalStore;
  let rawStorage;
  let syncApp;

  beforeEach(() => {
    resetRecoveryGate();
    clearCommittedDeviceSeq();
    rawStorage = new MockMemoryStorage();
    journalStore = new JournalStore(rawStorage);
    storageEngine = new MemoryBackend();

    syncApp = express();
    syncApp.use(express.json());
    syncApp.use('/api/sync', syncRouter);
  });

  it('preserves single commit order and marks IDB acked after SQLite commit', async () => {
    const doc = new LwwElementSet('device-A');
    const syncManager = new SyncManager(doc, '/api/sync', journalStore, storageEngine);

    const op = {
      device_id: 'dev-1',
      seq: 1,
      id: 'disp-101',
      status: 'en-route',
      timestamp: Date.now(),
    };

    const result = await syncManager.dispatch(op);
    expect(result.stored).toBe(true);
    expect(result.outbox).toBe(false);

    // Both SQLite and IDB hold the entry, and IDB is marked acked
    const sqliteHw = storageEngine.getHighwater('dev-1');
    const idbHw = journalStore.getHighwater('dev-1');
    expect(sqliteHw).toBe(1);
    expect(idbHw).toBe(1);
    expect(journalStore.getUnackedEntries(0, 'dev-1').length).toBe(0);
  });

  it('reconciles crash where IDB is ahead of SQLite by replaying only seq > sqlite_hw (zero dupes)', async () => {
    // Simulate crash after IDB put but before SQLite commit:
    // SQLite has committed up to seq 2, while IDB holds up to seq 4
    await storageEngine.appendBatch('dispatches', [
      { device_id: 'dev-1', seq: 1, id: 'd-1' },
      { device_id: 'dev-1', seq: 2, id: 'd-2' },
    ]);
    journalStore.append('dev-1', 1, { id: 'd-1' });
    journalStore.append('dev-1', 2, { id: 'd-2' });
    journalStore.append('dev-1', 3, { id: 'd-3' });
    journalStore.append('dev-1', 4, { id: 'd-4' });

    expect(storageEngine.getHighwater('dev-1')).toBe(2);
    expect(journalStore.getHighwater('dev-1')).toBe(4);

    // Run crash resurrection
    const report = await reconcileAndResurrect({
      storageEngine,
      journalStore,
      deviceId: 'dev-1',
    });

    expect(report.recovered).toBe(true);
    expect(report.sqliteHighwater).toBe(2);
    expect(report.idbHighwater).toBe(4);
    expect(report.replayedOps).toBe(2); // Only replayed seq 3 and seq 4!

    // Verify SQLite now holds exactly 4 rows with no duplicates
    const allRows = storageEngine.stores.get('dispatches');
    expect(allRows.length).toBe(4);
    const seqs = allRows.map((r) => r.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  it('detects torn WAL tail and logs torn_frames_dropped counter without panicking', async () => {
    // Inject torn WAL mock
    storageEngine.recoverTornWal = () => ({ tornFramesDropped: 1, ok: true });

    const report = await reconcileAndResurrect({
      storageEngine,
      journalStore,
      deviceId: 'dev-1',
    });

    expect(report.tornFramesDropped).toBe(1);
    expect(report.recovered).toBe(true);
  });

  it('refuses zombie snapshot when snapshot journal_highwater is ahead without IDB coverage', async () => {
    // SQLite at seq 5, IDB at seq 5, but snapshot claims journal_highwater 10
    await storageEngine.appendBatch('dispatches', [
      { device_id: 'dev-1', seq: 5, id: 'd-5' },
    ]);
    journalStore.append('dev-1', 5, { id: 'd-5' });

    const report = await reconcileAndResurrect({
      storageEngine,
      journalStore,
      snapshotHeader: { journal_highwater: 10 },
      deviceId: 'dev-1',
    });

    expect(report.zombieSnapshotsRefused).toBe(1);
  });

  it('fences SyncManager uploads until crash recovery emits RECOVERY_COMPLETE', async () => {
    const doc = new LwwElementSet('dev-1');
    doc.set('item-1', 'active');
    const syncManager = new SyncManager(doc, '/api/sync', journalStore, storageEngine);

    resetRecoveryGate();
    expect(isRecoveryComplete()).toBe(false);

    let uploadStarted = false;
    let uploadFinished = false;

    const mockFetcher = async (url, opts) => {
      uploadStarted = true;
      return {
        ok: true,
        json: async () => ({ operations: [] }),
      };
    };

    // Trigger sync in background while gate is closed
    const syncPromise = syncManager.sync(mockFetcher).then(() => {
      uploadFinished = true;
    });

    // Check that upload did not start yet because recovery is not complete
    expect(uploadStarted).toBe(false);
    expect(uploadFinished).toBe(false);

    // Complete recovery
    await reconcileAndResurrect({
      storageEngine,
      journalStore,
      deviceId: 'dev-1',
    });

    expect(isRecoveryComplete()).toBe(true);
    await syncPromise;
    expect(uploadStarted).toBe(true);
    expect(uploadFinished).toBe(true);
  });

  it('server sync endpoint deduplicates replayed (device_id, seq) returning HTTP 200 { deduped: true }', async () => {
    const payload = {
      operations: [
        {
          key: 'req-1',
          value: { status: 'open' },
          actor: 'dev-1',
          counter: 1,
          device_id: 'dev-1',
          seq: 101,
          deleted: false,
          timestamp: Date.now(),
        },
      ],
      vectorClock: { 'dev-1': 1 },
    };

    // First upload
    const res1 = await request(syncApp).post('/api/sync').send(payload);
    expect(res1.status).toBe(200);
    expect(res1.body.deduped).toBeUndefined();

    // Replay after reboot (same device_id and seq)
    const res2 = await request(syncApp).post('/api/sync').send(payload);
    expect(res2.status).toBe(200);
    expect(res2.body.deduped).toBe(true);
  });
});
