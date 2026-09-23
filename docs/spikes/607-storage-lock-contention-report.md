# Spike #607: Storage Lock Contention Analysis Report

Feeds [ADR-007](../adr/ADR-007-offline-storage.md). Raw numbers: [`results/storage-contention.json`](results/storage-contention.json).

## What was built

| File | Purpose |
|---|---|
| `src/services/storageEngine.js` | `WriteAheadBuffer` (group commit, size- and time-triggered, single in-flight flush, overflow policy), `IndexedDbBackend` (durability hints, lock-wait timing, newest-first reads, `deleteOldest`), `SqliteOpfsBackend` (`opfs` / `opfs-wl` / `opfs-sahpool` VFS, WAL + `locking_mode=EXCLUSIVE`, `BEGIN IMMEDIATE` with SQLITE_BUSY backoff timing), `createStorageEngine()`, `estimateStorage()` |
| `src/workers/telemetryWorker.js` | Synthetic GPS producer at a fixed rate with drift correction and backpressure (`maxPending`). Three roles: `writer` (own connection), `forward` (posts to an owner over `MessagePort`) and `owner` (holds the single SQLite connection). Also a quota-recovery probe. |
| `scripts/spikes/storage-bench/` + `storage_contention_benchmark.js` | Serves the repo through Vite with COOP/COEP headers and runs each scenario in a fresh Playwright Chromium context |
| `test/storage-engine.test.js` | 21 tests covering buffer semantics, IndexedDB (fake-indexeddb), real SQLite WASM (in-memory under Node), backpressure, quota recovery and the owner/forward topology |

## Method

- **Browser:** Chromium 147.0.7727.15, headless. The page is cross-origin isolated, so the `opfs` VFS and `SharedArrayBuffer` are available.
- **Contention:** 4 module workers × 125 Hz = **500 writes/s for 15 s** (7,500 records of about 96 bytes). The main thread reads the newest 50 rows every 100 ms: directly from IndexedDB, or through the owner/reader worker for SQLite. A `requestAnimationFrame` monitor and a long-task observer watch the UI thread.
- **Saturation:** the same 4 workers write as fast as possible for 6 s (up to 512 in flight each).
- Each scenario starts from empty IndexedDB and OPFS in a new browser context.

Reproduce: `CHROMIUM_PATH=/path/to/chrome npm run spike:storage`.

## Results: 500 writes/s across 4 workers

| Scenario | Throughput | Write p95 | Read p50 / p95 | Transactions | Lock wait p95 | Journal | Shed / errors |
|---|---|---|---|---|---|---|---|
| IndexedDB, per-write, default durability | 497/s | 4.1 ms | 0.6 / 1.4 ms | 1,875 | 3.1 ms | — | 0 / 0 |
| IndexedDB, per-write, strict | 498/s | 5.1 ms | 0.6 / 2.4 ms | 1,875 | 4.0 ms | — | 0 / 0 |
| IndexedDB, batched, relaxed | 498/s | 60.1 ms | 0.7 / 2.6 ms | 230 | 3.7 ms | — | 0 / 0 |
| IndexedDB, batched, strict | 498/s | 60.6 ms | 0.6 / 1.7 ms | 230 | 5.0 ms | — | 0 / 0 |
| SQLite `opfs`, 4 direct connections, per-write | **37/s** | 1,583 ms | 8.7 / **18,034 ms** | — | — | delete (WAL refused) | **2,449** / 0 |
| SQLite `opfs-wl`, 4 direct connections, per-write | — | — | — | — | — | — | **page crashed** |
| SQLite `opfs-wl`, 4 direct connections, batched | **66/s** | 2,838 ms | 181 / 1,276 ms | — | — | delete (WAL refused) | **5,117 / 955** |
| SQLite `opfs-sahpool`, single owner, batched, **WAL** | 497/s | 77.1 ms | 2.8 / 14.8 ms | 241 | 0 | wal | 0 / 0 |
| SQLite `opfs-sahpool`, single owner, batched, rollback | 496/s | 90.3 ms | 2.5 / 16.9 ms | 216 | 0 | delete | 0 / 0 |
| SQLite `opfs`, single owner, batched, WAL | 496/s | 86.2 ms | 2.4 / 16.3 ms | 222 | 0 | wal | 0 / 0 |

In every scenario: 0 long tasks, and at most 1 frame gap over 50 ms out of about 900 frames.

Notes:

- The write p95 of the batched rows is the 50 ms flush window plus the commit, which is the intended trade.
- The direct-SQLite rows ran with `maxPending: 64` per worker. Without it, the same scenario queued thousands of writes and needed more than 8 minutes to drain.
- The Chromium console showed the cause: `GetSyncHandleError … Access Handles cannot be created if there is another open Access Handle`. The `opfs` VFS retries this inside `xLock()` by blocking the worker with `Atomics.wait`, so even timers in the writer workers stop firing.

## Results: throughput ceiling (4 workers, saturating)

| Scenario | Ceiling | Write p95 | Read p95 during saturation | Transactions |
|---|---|---|---|---|
| IndexedDB, per-write | 1,479/s | 5.4 ms | 2.4 ms | 2,243 |
| IndexedDB, batched | 2,999/s | 1,113 ms | 292 ms | 10 (about 2,100 records each) |
| **SQLite `opfs-sahpool` owner, WAL** | **4,721/s** | 621 ms | 237 ms | 26 |

At saturation, batching lets reads queue behind very large write transactions (read p95 of 292 ms for IndexedDB). A production buffer should cap `maxBatch` (the default is 128) rather than flush everything queued.

## Findings

1. **At the target of 500/s, IndexedDB's transaction locking was not the bottleneck** on this machine. Reads stayed under 3 ms at p95 even with 1,875 overlapping per-write transactions. The starvation described in the issue did not reproduce on an idle desktop-class CPU.
2. **CPU pressure changes that.** One early run happened by accident while a heavy fuzz job was using the CPU. In that run, per-write IndexedDB fell to 264–287/s with write p95 around 10–11 s, while the batched configuration still held about 490/s. That run was uncontrolled and is not in the JSON. `--cpu-stress N` was added to measure this properly and has not been run yet.
3. **Group commit is the cheap, backend-independent fix.** It cut transactions 8× and doubled the IndexedDB ceiling.
4. **Multi-connection SQLite on OPFS is not viable**, because each OPFS file allows one sync access handle. It was 7–13× slower than IndexedDB at the same load, stalled reads for 18 s, crashed a page, and WAL was refused without exclusive locking.
5. **Single-owner SQLite is the fastest option** at 4,721/s with no lock waits. WAL made only a small difference against rollback at 500/s. Its cost is the owner topology: cross-tab owner election and a message hop that added about 12 ms to read p95.

## Not measured (outstanding)

- **Quota exhaustion and eviction.** The quota scenario overrides the origin quota to 40 MB through DevTools and logs 2 KB records until `QuotaExceededError`, then deletes the oldest 10 % and probes that writes resume.
  - This run was **invalid.** Its padding was a repeated character, and Chromium's IndexedDB compresses values (Snappy): 73,216 records × 2 KB used only 28.6 MB (391 B/record) and never hit the quota.
  - The SQLite variant failed because of a harness topology error: a separate reader connection conflicted with `opfs-sahpool`'s exclusivity.
  - Both are fixed (random padding; owner topology) but were not re-run within the time box: `node scripts/spikes/storage_contention_benchmark.js --only quota/`.
  - Eviction under disk pressure cannot be triggered from a page. It follows the browser's best-effort LRU policy unless `navigator.storage.persist()` is granted; `persisted` was `false` in headless Chromium.
- Real low-end Android devices.
- Contention across several tabs. This spike used several workers in one tab; each tab would add its own connections.
