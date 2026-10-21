/**
 * High-throughput offline client storage (spike #607, ADR-007).
 *
 * Three pieces, usable from the main thread or a Web Worker:
 *
 *  - `WriteAheadBuffer` — a backend-agnostic in-memory write-ahead buffer
 *    that group-commits queued records into ONE transaction per flush
 *    (size- or time-triggered). This is what removes IndexedDB lock
 *    contention: 500 writes/s become ~20 transactions/s.
 *  - `IndexedDbBackend` — native IndexedDB with explicit durability hints.
 *  - `SqliteOpfsBackend` — SQLite WASM on the Origin Private File System
 *    (`opfs`, `opfs-wl` or `opfs-sahpool` VFS) with optional WAL journal.
 *
 * `createStorageEngine()` wires a backend behind a buffer and exposes
 * append/flush/read/stats. Nothing in the app imports this yet; the
 * contention benchmark (scripts/spikes/storage_contention_benchmark.js)
 * drives it through src/workers/telemetryWorker.js.
 */

export const STORES = ["telemetry", "messages", "frames", "dispatches"];

export class SqliteBusyError extends Error {
  constructor(message = "SQLITE_BUSY: database lock contention", { code = 5, lane = "telemetry", details = null } = {}) {
    super(message);
    this.name = "SqliteBusyError";
    this.code = code;
    this.lane = lane;
    this.details = details;
  }
}

export function isWorkerContext() {
  return typeof importScripts === "function" || (typeof self !== "undefined" && typeof window === "undefined");
}

export function assertWorkerContext() {
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    throw new Error("WorkerIsolationError: SQLite-WASM is restricted to dedicated Web Workers to prevent UI jank (ADR-007 / ISP-064)");
  }
}

export function getTelemetryPartitionName(dateOrTs = Date.now()) {
  const d = new Date(dateOrTs);
  const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return `telemetry_${ym}`;
}

const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/** Compact latency summary; `samples` is left untouched. */
export function summarize(samples) {
  if (!samples.length) return { n: 0 };
  const s = Float64Array.from(samples).sort();
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  let sum = 0;
  for (const v of s) sum += v;
  const r = (v) => Math.round(v * 100) / 100;
  return { n: s.length, mean: r(sum / s.length), p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(s[s.length - 1]) };
}

/** True for IndexedDB/OPFS/SQLite "disk full" style failures. */
export function isQuotaError(err) {
  if (!err) return false;
  const name = err.name || "";
  const msg = String(err.message || err);
  return (
    name === "QuotaExceededError" ||
    /quota|SQLITE_FULL|database or disk is full|no space/i.test(msg)
  );
}

// ── Write-ahead buffer (group commit) ───────────────────────────────────────

export class WriteAheadBuffer {
  /**
   * @param {(store: string, records: object[]) => Promise<unknown>} sink
   *   commits one batch atomically (one transaction).
   * @param {object} [options]
   * @param {number} [options.maxBatch=128] flush as soon as this many are queued
   * @param {number} [options.flushMs=50] otherwise flush this long after the first enqueue
   * @param {number} [options.maxBuffered=20000] backpressure threshold
   * @param {"drop-oldest"|"reject"} [options.overflow="drop-oldest"]
   *   telemetry prefers losing stale fixes to blocking producers.
   */
  constructor(sink, { maxBatch = 128, flushMs = 50, maxBuffered = 20000, overflow = "drop-oldest" } = {}) {
    this.sink = sink;
    this.maxBatch = maxBatch;
    this.flushMs = flushMs;
    this.maxBuffered = maxBuffered;
    this.overflow = overflow;
    this.queue = [];
    this.timer = null;
    this.inflight = null;
    this.metrics = { enqueued: 0, committed: 0, dropped: 0, failed: 0, batches: 0, queueWaitMs: [], commitMs: [], batchSizes: [] };
  }

  get size() {
    return this.queue.length;
  }

  /** Resolves once the record is durably committed (or rejects). */
  enqueue(store, record) {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= this.maxBuffered) {
        if (this.overflow === "reject") {
          this.metrics.dropped++;
          reject(new Error("WriteAheadBuffer full"));
          return;
        }
        const dropped = this.queue.shift();
        this.metrics.dropped++;
        dropped.reject(new Error("Dropped by WriteAheadBuffer (overflow)"));
      }
      this.queue.push({ store, record, t: now(), resolve, reject });
      this.metrics.enqueued++;
      if (this.queue.length >= this.maxBatch) this.#schedule(0);
      else this.#schedule(this.flushMs);
    });
  }

  #schedule(delay) {
    if (this.timer !== null) {
      if (delay > 0) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, delay);
  }

  /** Commits everything queued so far. Only one flush runs at a time. */
  async flush() {
    while (this.inflight) await this.inflight.catch(() => {});
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, this.queue.length);
    this.inflight = this.#commit(batch);
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
      if (this.queue.length) this.#schedule(this.queue.length >= this.maxBatch ? 0 : this.flushMs);
    }
  }

  async #commit(batch) {
    const byStore = new Map();
    for (const item of batch) {
      let list = byStore.get(item.store);
      if (!list) byStore.set(item.store, (list = []));
      list.push(item);
    }
    const start = now();
    const m = this.metrics;
    let firstError = null;
    for (const [store, items] of byStore) {
      try {
        await this.sink(store, items.map((i) => i.record));
        const done = now();
        m.batches++;
        m.batchSizes.push(items.length);
        m.commitMs.push(done - start);
        for (const i of items) {
          m.queueWaitMs.push(start - i.t);
          m.committed++;
          i.resolve(done - i.t);
        }
      } catch (err) {
        m.failed += items.length;
        for (const i of items) i.reject(err);
        firstError = firstError || err;
      }
    }
    if (firstError) throw firstError;
  }

  async close() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
  }

  stats() {
    const m = this.metrics;
    return {
      enqueued: m.enqueued,
      committed: m.committed,
      dropped: m.dropped,
      failed: m.failed,
      batches: m.batches,
      avgBatch: m.batches ? Math.round((m.committed / m.batches) * 10) / 10 : 0,
      queueWaitMs: summarize(m.queueWaitMs),
      commitMs: summarize(m.commitMs),
    };
  }
}

// ── IndexedDB backend ───────────────────────────────────────────────────────

export class IndexedDbBackend {
  constructor({ dbName = "helphone-offline", durability = "default", idb } = {}) {
    this.dbName = dbName;
    this.durability = durability;
    this.idb = idb || (typeof indexedDB !== "undefined" ? indexedDB : null);
    this.db = null;
    this.kind = "indexeddb";
  }

  open() {
    if (!this.idb) return Promise.reject(new Error("IndexedDB unavailable"));
    return new Promise((resolve, reject) => {
      const req = this.idb.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of STORES)
          if (!db.objectStoreNames.contains(name)) {
            const os = db.createObjectStore(name, { keyPath: "id", autoIncrement: true });
            os.createIndex("ts", "ts");
          }
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve(this);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });
  }

  #tx(store, mode) {
    return this.durability === "default"
      ? this.db.transaction(store, mode)
      : this.db.transaction(store, mode, { durability: this.durability });
  }

  /**
   * One readwrite transaction for the whole batch. Resolves with
   * `lockWaitMs` (transaction created → first request served, i.e. the
   * time spent queued behind overlapping transactions) and `commitMs`.
   */
  writeBatch(store, records) {
    return new Promise((resolve, reject) => {
      const t0 = now();
      let firstAt = 0;
      const tx = this.#tx(store, "readwrite");
      const os = tx.objectStore(store);
      records.forEach((r, i) => {
        const req = os.add(r);
        if (i === 0) req.onsuccess = () => (firstAt = now());
      });
      tx.oncomplete = () => resolve({ lockWaitMs: (firstAt || now()) - t0, commitMs: now() - t0 });
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });
  }

  /** Newest `limit` records (reverse primary-key cursor). */
  readLatest(store, limit = 50) {
    return new Promise((resolve, reject) => {
      const out = [];
      const tx = this.#tx(store, "readonly");
      const req = tx.objectStore(store).openCursor(null, "prev");
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor && out.length < limit) {
          out.push(cursor.value);
          cursor.continue();
        } else resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  }

  count(store) {
    return new Promise((resolve, reject) => {
      const req = this.#tx(store, "readonly").objectStore(store).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** Deletes the oldest `n` records — the recovery path after a quota error. */
  deleteOldest(store, n) {
    return new Promise((resolve, reject) => {
      let deleted = 0;
      const tx = this.#tx(store, "readwrite");
      const req = tx.objectStore(store).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor && deleted < n) {
          cursor.delete();
          deleted++;
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(tx.error);
    });
  }

  async incrementalVacuum() {
    return { pagesFreed: 0, aborted: false, disabled: true };
  }

  async dropPartition() {
    return 0;
  }

  async dropExpiredTelemetry() {
    return 0;
  }

  quickCheck() {
    return true;
  }

  checkpoint() {
    return null;
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
  }
}

// ── SQLite WASM on OPFS ─────────────────────────────────────────────────────

const TELEMETRY_COLUMNS = ["ts", "worker", "seq", "lat", "lng", "acc", "payload"];

export class SqliteOpfsBackend {
  /**
   * @param {object} [options]
   * @param {"opfs"|"opfs-wl"|"opfs-sahpool"|"memory"} [options.vfs="opfs-sahpool"]
   * @param {string} [options.filename="/helphone-offline.sqlite3"]
   * @param {"wal"|"delete"|"truncate"|"persist"|"memory"} [options.journalMode="wal"]
   * @param {boolean} [options.exclusive] `locking_mode=EXCLUSIVE`; required for
   *   WAL on the OPFS VFSes (no shared-memory wal-index in WASM).
   * @param {Function} [options.sqlite3InitModule] injectable for tests.
   * @param {boolean} [options.allowMainThread=false]
   */
  constructor({ vfs = "opfs-sahpool", filename = "/helphone-offline.sqlite3", journalMode = "wal", exclusive, synchronous = "normal", sqlite3InitModule, allowMainThread = false } = {}) {
    this.vfs = vfs;
    this.filename = filename;
    this.journalMode = journalMode;
    this.exclusive = exclusive ?? journalMode === "wal";
    this.synchronous = synchronous;
    this.init = sqlite3InitModule;
    this.allowMainThread = allowMainThread;
    this.kind = `sqlite-${vfs}`;
    this.db = null;
    this.sqlite3 = null;
    this.pool = null;
    this.effectiveJournalMode = null;
    this.busyRetries = 0;
    this.droppedTelemetry = 0;
  }

  async open() {
    if (this.vfs !== "memory" && !this.allowMainThread) {
      assertWorkerContext();
    }
    const init = this.init || (await import("@sqlite.org/sqlite-wasm")).default;
    const sqlite3 = await init();
    this.sqlite3 = sqlite3;
    const { oo1 } = sqlite3;
    if (this.vfs === "opfs-sahpool") {
      this.pool = await sqlite3.installOpfsSAHPoolVfs({ name: "helphone-sahpool", directory: "/helphone-sahpool", initialCapacity: 6 });
      this.db = new this.pool.OpfsSAHPoolDb(this.filename);
    } else if (this.vfs === "opfs") {
      if (!oo1.OpfsDb) throw new Error("opfs VFS unavailable (needs COOP/COEP + SharedArrayBuffer)");
      this.db = new oo1.OpfsDb(this.filename, "c");
    } else if (this.vfs === "opfs-wl") {
      if (!oo1.OpfsWlDb) throw new Error("opfs-wl VFS unavailable");
      this.db = new oo1.OpfsWlDb(this.filename, "c");
    } else {
      this.db = new oo1.DB(":memory:", "c");
    }
    // Pragmas that must precede the first read/write of the connection.
    if (this.exclusive) this.db.exec("PRAGMA locking_mode=EXCLUSIVE");
    this.effectiveJournalMode = String(this.db.selectValue(`PRAGMA journal_mode=${this.journalMode}`)).toLowerCase();
    this.db.exec(`PRAGMA synchronous=${this.synchronous}`);
    try {
      this.db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    } catch (_err) {
      // Ignore if auto_vacuum is not supported on this VFS/build
    }

    this.#withBusyRetrySync(() => {
      for (const store of STORES) {
        if (store === "telemetry") {
          const curPartition = getTelemetryPartitionName();
          this.ensurePartitionTable(curPartition);
          this.syncTelemetryView();
        } else {
          this.db.exec(
            `CREATE TABLE IF NOT EXISTS ${store} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${TELEMETRY_COLUMNS.map((c) => `${c} ${c === "payload" ? "TEXT" : "REAL"}`).join(", ")})`,
          );
        }
      }
    });
    return this;
  }

  ensurePartitionTable(tableName) {
    if (!this.knownPartitions) this.knownPartitions = new Set();
    if (this.knownPartitions.has(tableName)) return;
    this.#withBusyRetrySync(() => {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${tableName} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${TELEMETRY_COLUMNS.map((c) => `${c} ${c === "payload" ? "TEXT" : "REAL"}`).join(", ")})`,
      );
      this.knownPartitions.add(tableName);
      this.syncTelemetryView();
    });
  }

  syncTelemetryView() {
    this.#withBusyRetrySync(() => {
      let names = [];
      try {
        const rows = this.db.selectObjects(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'telemetry_%' ORDER BY name"
        );
        names = rows.map((r) => r.name);
      } catch {
        const rows = this.db.selectObjects(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'telemetry_%' ORDER BY name"
        );
        names = rows.map((r) => r.name);
      }
      this.db.exec("DROP VIEW IF EXISTS telemetry");
      if (names.length === 0) {
        const cur = getTelemetryPartitionName();
        this.ensurePartitionTable(cur);
        this.db.exec(`CREATE VIEW IF NOT EXISTS telemetry AS SELECT * FROM ${cur}`);
      } else {
        const unionSql = names.map((t) => `SELECT * FROM ${t}`).join(" UNION ALL ");
        this.db.exec(`CREATE VIEW IF NOT EXISTS telemetry AS ${unionSql}`);
      }
    });
  }

  dropPartition(partitionName) {
    let dropped = 0;
    this.#withBusyRetrySync(() => {
      this.db.exec(`DROP TABLE IF EXISTS ${partitionName}`);
      dropped = 1;
      this.syncTelemetryView();
    });
    return dropped;
  }

  dropExpiredTelemetry(retentionDays = 30) {
    const cutoffMs = Date.now() - retentionDays * 86400000;
    const cutoffPartition = getTelemetryPartitionName(cutoffMs);
    let dropped = 0;
    this.#withBusyRetrySync(() => {
      let rows = [];
      try {
        rows = this.db.selectObjects(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'telemetry_%' ORDER BY name"
        );
      } catch {
        rows = this.db.selectObjects(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'telemetry_%' ORDER BY name"
        );
      }
      for (const r of rows) {
        if (r.name < cutoffPartition) {
          this.db.exec(`DROP TABLE IF EXISTS ${r.name}`);
          dropped++;
        }
      }
      if (dropped > 0) {
        this.syncTelemetryView();
      }
    });
    return dropped;
  }

  #isBusy(err) {
    const rc = err && (err.resultCode ?? err.rc);
    return rc === 5 || rc === 6 || /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(String(err && err.message));
  }

  #withBusyRetrySync(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return fn();
      } catch (err) {
        if (!this.#isBusy(err) || attempt > 200) throw err;
        this.busyRetries++;
      }
    }
  }

  /**
   * Priority-aware batch writes:
   *  - lane "dispatch" (priority "immediate"): BEGIN IMMEDIATE with up to busyTimeout retry,
   *    throws SqliteBusyError on timeout to allow outbox overflow.
   *  - lane "telemetry" (priority "deferred"): BEGIN DEFERRED with fast yield / coalesce under contention.
   */
  async writeBatch(store, records, { lane = "telemetry", priority = "deferred", busyTimeout = 5000, onCoalesce = null } = {}) {
    const t0 = now();
    let lockWaitMs = 0;
    const isDispatch = lane === "dispatch" || priority === "immediate" || store === "dispatches";
    const beginTx = isDispatch ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED";
    const maxRetries = isDispatch ? 400 : 20;

    for (let attempt = 0; ; attempt++) {
      try {
        this.db.exec(beginTx);
        break;
      } catch (err) {
        if (!this.#isBusy(err) || attempt > maxRetries || lockWaitMs >= busyTimeout) {
          if (this.#isBusy(err) && isDispatch) {
            throw new SqliteBusyError(`SQLITE_BUSY: dispatch write lock acquisition timed out after ${Math.round(lockWaitMs)}ms`, { code: 5, lane: "dispatch", details: err });
          }
          if (this.#isBusy(err) && !isDispatch) {
            this.droppedTelemetry += records.length;
            if (onCoalesce) onCoalesce(records);
            return { lockWaitMs, commitMs: now() - t0, dropped: records.length, coalesced: true };
          }
          throw err;
        }
        this.busyRetries++;
        const w0 = now();
        await new Promise((r) => setTimeout(r, Math.min(isDispatch ? 50 : 15, 1 + attempt * 2)));
        lockWaitMs += now() - w0;
      }
    }

    try {
      if (store === "telemetry") {
        const byPartition = new Map();
        for (const r of records) {
          const partName = getTelemetryPartitionName(r.ts);
          let list = byPartition.get(partName);
          if (!list) byPartition.set(partName, (list = []));
          list.push(r);
        }
        for (const [partName, partRecords] of byPartition) {
          this.ensurePartitionTable(partName);
          const stmt = this.db.prepare(
            `INSERT INTO ${partName} (${TELEMETRY_COLUMNS.join(",")}) VALUES (${TELEMETRY_COLUMNS.map(() => "?").join(",")})`
          );
          try {
            for (const r of partRecords) {
              stmt.bind(
                TELEMETRY_COLUMNS.map((c) => (c === "payload" ? JSON.stringify(r.payload ?? null) : r[c] ?? null))
              ).stepReset();
            }
          } finally {
            stmt.finalize();
          }
        }
      } else {
        const stmt = this.db.prepare(
          `INSERT INTO ${store} (${TELEMETRY_COLUMNS.join(",")}) VALUES (${TELEMETRY_COLUMNS.map(() => "?").join(",")})`
        );
        try {
          for (const r of records) {
            stmt.bind(
              TELEMETRY_COLUMNS.map((c) => (c === "payload" ? JSON.stringify(r.payload ?? null) : r[c] ?? null))
            ).stepReset();
          }
        } finally {
          stmt.finalize();
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
    return { lockWaitMs, commitMs: now() - t0, dropped: 0 };
  }

  async appendBatch(store, records, opts) {
    return this.writeBatch(store, records, opts);
  }

  async readLatest(store, limit = 50) {
    return this.#withBusyRetrySync(() => this.db.selectObjects(`SELECT * FROM ${store} ORDER BY id DESC LIMIT ?`, [limit]));
  }

  async count(store) {
    return this.#withBusyRetrySync(() => Number(this.db.selectValue(`SELECT count(*) FROM ${store}`)));
  }

  async deleteOldest(store, n) {
    if (store === "telemetry") {
      let remaining = n;
      let totalDeleted = 0;
      let rows = [];
      try {
        rows = this.db.selectObjects("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'telemetry_%' ORDER BY name");
      } catch {
        rows = this.db.selectObjects("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'telemetry_%' ORDER BY name");
      }
      for (const r of rows) {
        if (remaining <= 0) break;
        this.db.exec({ sql: `DELETE FROM ${r.name} WHERE id IN (SELECT id FROM ${r.name} ORDER BY id LIMIT ?)`, bind: [remaining] });
        const c = this.db.changes();
        totalDeleted += c;
        remaining -= c;
      }
      return totalDeleted;
    }
    this.db.exec({ sql: `DELETE FROM ${store} WHERE id IN (SELECT id FROM ${store} ORDER BY id LIMIT ?)`, bind: [n] });
    return this.db.changes();
  }

  /** Folds the WAL back into the main db file (bounded WAL growth). */
  checkpoint(mode = "TRUNCATE") {
    if (this.effectiveJournalMode !== "wal") return null;
    return this.db.selectArray(`PRAGMA wal_checkpoint(${mode})`);
  }

  async incrementalVacuum({ pages = 50, busyTimeoutMs = 5000, abortOnBacklog = null, maxPages = 10000 } = {}) {
    this.checkpoint("TRUNCATE");
    const t0 = now();
    let totalFreed = 0;

    while (totalFreed < maxPages) {
      if (abortOnBacklog) {
        const shouldAbort = typeof abortOnBacklog === "function" ? await abortOnBacklog() : Boolean(abortOnBacklog);
        if (shouldAbort) {
          return {
            pagesFreed: totalFreed,
            freelistRemaining: Number(this.db.selectValue("PRAGMA freelist_count") || 0),
            aborted: true,
            reason: "dispatch_backlog",
            elapsedMs: now() - t0,
          };
        }
      }

      const freelistBefore = Number(this.db.selectValue("PRAGMA freelist_count") || 0);
      if (freelistBefore <= 0) break;

      const step = Math.min(pages, freelistBefore);
      this.#withBusyRetrySync(() => {
        this.db.exec(`PRAGMA incremental_vacuum(${step})`);
      });
      const freelistAfter = Number(this.db.selectValue("PRAGMA freelist_count") || 0);
      const freed = Math.max(0, freelistBefore - freelistAfter);
      totalFreed += (freed || step);

      if (freelistAfter <= 0) break;
    }

    return {
      pagesFreed: totalFreed,
      freelistRemaining: Number(this.db.selectValue("PRAGMA freelist_count") || 0),
      aborted: false,
      elapsedMs: now() - t0,
    };
  }

  quickCheck() {
    return this.#withBusyRetrySync(() => {
      const res = this.db.selectValue("PRAGMA quick_check");
      return String(res).toLowerCase() === "ok";
    });
  }

  getHighwater(deviceId = null) {
    return this.#withBusyRetrySync(() => {
      try {
        if (deviceId) {
          const val = this.db.selectValue("SELECT MAX(seq) FROM dispatches WHERE device_id = ?", [deviceId]);
          return Number(val || 0);
        }
        const val = this.db.selectValue("SELECT MAX(seq) FROM dispatches");
        return Number(val || 0);
      } catch {
        return 0;
      }
    });
  }

  recoverTornWal() {
    let tornFramesDropped = 0;
    try {
      const ok = this.quickCheck();
      if (!ok) {
        this.checkpoint("TRUNCATE");
        tornFramesDropped = 1;
      }
    } catch {
      this.checkpoint("TRUNCATE");
      tornFramesDropped = 1;
    }
    return { tornFramesDropped, ok: this.quickCheck() };
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
    if (this.pool && this.pool.pauseVfs) {
      try {
        this.pool.pauseVfs();
      } catch {
        // other handles still open
      }
    }
  }
}

// ── In-memory backend (tests / fallback when no persistent storage) ─────────

export class MemoryBackend {
  constructor({ commitDelayMs = 0 } = {}) {
    this.kind = "memory";
    this.stores = new Map(STORES.map((s) => [s, []]));
    this.nextId = 1;
    this.commitDelayMs = commitDelayMs;
    this.transactions = 0;
  }

  async open() {
    return this;
  }

  async writeBatch(store, records) {
    const t0 = now();
    if (this.commitDelayMs) await new Promise((r) => setTimeout(r, this.commitDelayMs));
    const list = this.stores.get(store);
    for (const r of records) list.push({ ...r, id: this.nextId++ });
    this.transactions++;
    return { lockWaitMs: 0, commitMs: now() - t0 };
  }

  async appendBatch(store, records, opts) {
    return this.writeBatch(store, records, opts);
  }

  async readLatest(store, limit = 50) {
    return this.stores.get(store).slice(-limit).reverse();
  }

  async count(store) {
    return this.stores.get(store).length;
  }

  async deleteOldest(store, n) {
    return this.stores.get(store).splice(0, n).length;
  }

  async incrementalVacuum({ abortOnBacklog } = {}) {
    if (abortOnBacklog) {
      const shouldAbort = typeof abortOnBacklog === "function" ? await abortOnBacklog() : Boolean(abortOnBacklog);
      if (shouldAbort) {
        return { pagesFreed: 0, aborted: true, reason: "dispatch_backlog" };
      }
    }
    return { pagesFreed: 0, aborted: false };
  }

  async dropPartition(name) {
    if (this.stores.has(name)) {
      this.stores.delete(name);
      return 1;
    }
    return 0;
  }

  async dropExpiredTelemetry() {
    return 0;
  }

  quickCheck() {
    return true;
  }

  getHighwater(deviceId = null) {
    const list = this.stores.get("dispatches") || [];
    let max = 0;
    for (const item of list) {
      if (deviceId && item.device_id !== deviceId) continue;
      const s = Number(item.seq || 0);
      if (s > max) max = s;
    }
    return max;
  }

  checkpoint() {
    return null;
  }

  close() {}
}

// ── Engine facade ───────────────────────────────────────────────────────────

/**
 * @param {object} options
 * @param {"indexeddb"|"opfs-sqlite"|"memory"|object} [options.backend="indexeddb"]
 *   a backend name or an already-constructed backend instance.
 * @param {false|object} [options.buffer] WriteAheadBuffer options, or
 *   `false` to commit every write in its own transaction (the naive path).
 */
export async function createStorageEngine({ backend = "indexeddb", backendOptions = {}, buffer = {} } = {}) {
  let targetBackend = backend;
  if (backend === "opfs-sqlite") {
    const isBrowserMain = typeof window !== "undefined" && typeof document !== "undefined";
    if (isBrowserMain && backendOptions.vfs !== "memory" && !backendOptions.allowMainThread) {
      if (backendOptions.enforceWorker !== false) {
        console.warn("[storageEngine] Worker isolation: SQLite-WASM is restricted to Web Workers. Falling back to IndexedDB with vacuum disabled.");
        targetBackend = "indexeddb";
        backendOptions = { ...backendOptions, vacuumDisabled: true };
      }
    }
  }

  const impl =
    typeof targetBackend === "object"
      ? targetBackend
      : targetBackend === "opfs-sqlite"
        ? new SqliteOpfsBackend(backendOptions)
        : targetBackend === "memory"
          ? new MemoryBackend(backendOptions)
          : new IndexedDbBackend(backendOptions);
  await impl.open();

  const txn = { lockWaitMs: [], commitMs: [], count: 0 };
  const sink = async (store, records, opts) => {
    const r = await impl.writeBatch(store, records, opts);
    txn.count++;
    txn.lockWaitMs.push(r.lockWaitMs);
    txn.commitMs.push(r.commitMs);
    return r;
  };
  const wab = buffer === false ? null : new WriteAheadBuffer(sink, buffer);
  const direct = { committed: 0, failed: 0, latencyMs: [] };

  return {
    backend: impl,
    /** Queue (buffered) or write (unbuffered) one record; resolves on commit. */
    async append(store, record, options = {}) {
      if (wab) return wab.enqueue(store, record);
      const t0 = now();
      try {
        const res = await sink(store, [record], options);
        direct.committed++;
        const ms = now() - t0;
        direct.latencyMs.push(ms);
        return ms;
      } catch (err) {
        direct.failed++;
        throw err;
      }
    },
    flush: () => (wab ? wab.flush() : Promise.resolve()),
    readLatest: (store, limit) => impl.readLatest(store, limit),
    count: (store) => impl.count(store),
    deleteOldest: (store, n) => impl.deleteOldest(store, n),
    incrementalVacuum: (opts) => impl.incrementalVacuum ? impl.incrementalVacuum(opts) : Promise.resolve({ pagesFreed: 0, disabled: true }),
    dropPartition: (name) => impl.dropPartition ? impl.dropPartition(name) : Promise.resolve(0),
    dropExpiredTelemetry: (days) => impl.dropExpiredTelemetry ? impl.dropExpiredTelemetry(days) : Promise.resolve(0),
    quickCheck: () => impl.quickCheck ? impl.quickCheck() : Promise.resolve(true),
    checkpoint: (mode) => impl.checkpoint ? impl.checkpoint(mode) : null,
    stats() {
      return {
        backend: impl.kind,
        journalMode: impl.effectiveJournalMode ?? null,
        busyRetries: impl.busyRetries ?? 0,
        droppedTelemetry: impl.droppedTelemetry ?? 0,
        transactions: txn.count,
        txnLockWaitMs: summarize(txn.lockWaitMs),
        txnCommitMs: summarize(txn.commitMs),
        buffer: wab ? wab.stats() : null,
        direct: wab ? null : { committed: direct.committed, failed: direct.failed, latencyMs: summarize(direct.latencyMs) },
      };
    },
    async close() {
      if (wab) await wab.close();
      impl.close();
    },
  };
}

/** navigator.storage quota/usage/persistence snapshot (null outside browsers). */
export async function estimateStorage() {
  const storage = typeof navigator !== "undefined" ? navigator.storage : null;
  if (!storage || !storage.estimate) return null;
  const { quota = 0, usage = 0, usageDetails } = await storage.estimate();
  const persisted = storage.persisted ? await storage.persisted() : null;
  return { quota, usage, usageDetails: usageDetails || null, persisted };
}
