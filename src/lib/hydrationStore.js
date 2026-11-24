/**
 * IndexedDB-backed hydration state (#931).
 *
 * One database, two object stores:
 *   kv   { key, value }                 resume vector under `crdt_resume_vector`
 *   ops  (autoIncrement) LwwOperation[] one row per committed page, in order
 *
 * Invariant: a page's operations and the checkpoint vector that describes them
 * are written in ONE readwrite transaction. The checkpoint can never get ahead
 * of the data it claims to cover, so resuming after a drop or a browser close
 * replays exactly the pages that were committed and fetches the rest.
 *
 * This store is the durable half of `hydratePaged({ storage, opsLog })`. The
 * `getItem` / `setItem` / `removeItem` methods keep it usable as a plain
 * storage adapter for the checkpoint key.
 */

const DB_NAME = 'helphone-crdt-hydration';
const DB_VERSION = 1;
const KV = 'kv';
const OPS = 'ops';

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function openHydrationDb(indexedDBImpl = globalThis.indexedDB, name = DB_NAME) {
  if (!indexedDBImpl) return Promise.reject(new Error('IndexedDB is unavailable'));
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(OPS)) db.createObjectStore(OPS, { autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class HydrationStore {
  constructor(db) {
    this.db = db;
  }

  static async open(indexedDBImpl, name) {
    return new HydrationStore(await openHydrationDb(indexedDBImpl, name));
  }

  async getItem(key) {
    const tx = this.db.transaction(KV, 'readonly');
    const row = await requestToPromise(tx.objectStore(KV).get(key));
    return row ? row.value : null;
  }

  async setItem(key, value) {
    const tx = this.db.transaction(KV, 'readwrite');
    tx.objectStore(KV).put({ key, value: String(value) });
    await transactionDone(tx);
  }

  async removeItem(key) {
    const tx = this.db.transaction(KV, 'readwrite');
    tx.objectStore(KV).delete(key);
    await transactionDone(tx);
  }

  /**
   * Atomically append one page of applied operations and advance the checkpoint.
   * `ops` may be empty (for example, a page that contained only duplicates).
   */
  async commitPage(ops, checkpointKey, checkpointValue) {
    const tx = this.db.transaction([OPS, KV], 'readwrite');
    if (ops.length > 0) tx.objectStore(OPS).add(ops);
    tx.objectStore(KV).put({ key: checkpointKey, value: String(checkpointValue) });
    await transactionDone(tx);
  }

  /**
   * Visit every committed page in commit order. `onPage` runs synchronously
   * inside the cursor callback, so only one page is held in memory at a time.
   */
  replay(onPage) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(OPS, 'readonly');
      const request = tx.objectStore(OPS).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        onPage(cursor.value);
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('replay aborted'));
    });
  }

  /** Drops every committed page. Called before a cold (snapshot) restart. */
  async clearOps() {
    const tx = this.db.transaction(OPS, 'readwrite');
    tx.objectStore(OPS).clear();
    await transactionDone(tx);
  }

  close() {
    this.db.close();
  }
}
