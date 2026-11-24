# Storage Optimization: Bounded Ring Buffer (#531)

## Problem

A wallet's expert verification history was append-only: `("ev", wallet, idx)` grew forever and each entry kept costing rent. Nothing bounded it.

## Design

`contract/contracts/helphone-contract/src/ring_buffer.rs` caps a per-owner history at `CAPACITY = 500` entries.

```
("evcount", wallet)             -> u32   total pushes ever (the write cursor)
("ev", wallet, index % 500)     -> value slot
```

`index` only ever grows. The readable window is `oldest ..= total - 1`, with `oldest = max(total - 500, 0)`. A push writes to `index % 500`; once the buffer is full that slot holds the oldest entry (`index - 500`), so the module reads it first and returns it as `evicted`. `lib.rs` turns that into an `Evicted` event.

Every entry point is O(1): one counter read, at most one slot read, one slot write, one counter write.

## Compatibility

While fewer than 500 entries exist, `slot == index`, so the keys are identical to the old unbounded layout. Existing histories read back unchanged and need no migration (covered by `history_written_before_the_ring_buffer_still_reads_back`). `record_expert_verification` still returns the count after the push.

Behaviour that changed: a wallet with more than 500 lifetime entries can no longer read the oldest ones. `get_expert_verifications(wallet, limit)` now caps by *retained* entries, not the lifetime total.

## Rent

Each push extends the TTL of the slot it wrote and of the counter to about 90 days once they fall under about 30 days. Because the buffer is bounded, so is the rent. Slots not rewritten recently can lapse independently; persistent entries are archived, not deleted, and can be restored.

Per-invocation write limits also apply on the network (50 ledger entries per invocation); a record touches 2, and the ring buffer never writes more.

## Events

```
topics: ["evicted", <wallet>]
data:   { index: u32, record: ExpertVerification }
```

Emitted only when a push displaces an entry. Indexers should archive `record` from this event, since it is no longer readable on chain afterwards.

## Client

`getExpertVerificationWindow(wallet)` in `src/lib/contract.ts` returns `{ total, capacity, oldest, retained, evicted }`. `src/lib/ringBuffer.ts` has the pure helpers (`verificationWindow`, `isRetained`, `recentIndexes`) so a UI pages within `[oldest, total)` and never asks for an evicted slot.

## Tests

- Rust (`ring_buffer.rs`, `test.rs`): fill to capacity with no eviction or event; the 501st entry evicts index 0 and emits the exact event; strict FIFO across more than two wraps; per-wallet isolation; legacy layout; TTL extension; listing capped by retained entries.
- JS (`test/ring-buffer.test.js`): window math, retention checks, recent-index paging, and the contract wrapper with only the RPC faked.

---

# Client SQLite-WASM Maintenance & Storage Optimization (ISP-064 / ISP-067)

## Problem: VACUUM Death Spiral

Under continuous field simulation, 5s telemetry inserts fragment SQLite-WASM rapidly, creating 35–60% freelist bloat after 7 days. Previous nightly full `VACUUM` attempts rewrote 200–600MB on-device databases under `EXCLUSIVE` lock, causing:
- 40–120s foreground freezes (2–6 fps, ANR on Android, Jetsam kills on iOS).
- Telemetry worker insert queue overflows with `SQLITE_BUSY` bursts.
- Priority dispatch inserts waiting 8–25s behind vacuum locks.
- Volunteers force-quitting mid-vacuum, leaving torn WAL frames and corrupt databases.

## Partitioned Retention Model (`telemetry_YYYYMM`)

Instead of row-by-row `DELETE` followed by space-reclaiming `VACUUM`, telemetry tables are partitioned by year and month:
```sql
CREATE TABLE IF NOT EXISTS telemetry_202605 (
  id TEXT PRIMARY KEY,
  device_id TEXT,
  seq INTEGER,
  timestamp INTEGER,
  lat REAL,
  lng REAL,
  accuracy REAL
);

-- Unified view across all active partitions
CREATE VIEW IF NOT EXISTS telemetry AS
  SELECT * FROM telemetry_202605
  UNION ALL
  SELECT * FROM telemetry_202604;
```

### Retention via Metadata DROP

When a 30-day retention window expires:
1. The backend issues `DROP TABLE IF EXISTS telemetry_YYYYMM`.
2. SQLite removes the table from metadata instantly (<5ms).
3. Space is returned immediately to the operating system or marked free with **zero page-rewriting** and **zero freelist fragmentation**.
4. Freelist bloat stays under 15% across 30 days of continuous operation.

## Budgeted Incremental Vacuum (`incremental_vacuum(50)`)

Full `VACUUM` is strictly forbidden in browser environments. For non-partitioned tables, `auto_vacuum=INCREMENTAL` is combined with budgeted page reclamation:

| Parameter | Value | Rationale |
|---|---|---|
| `PRAGMA auto_vacuum` | `INCREMENTAL` | Enables incremental page returns without full file rewrites |
| `PRAGMA page_size` | `4096` | Optimal balance for OPFS block access |
| `PRAGMA journal_mode` | `WAL` | Permits concurrent readers while single writer commits |
| `PRAGMA busy_timeout` | `5000` | 5000ms wait before SQLITE_BUSY error |
| Budget per step | `50 pages` | ~200KB per step, completing in <15ms |
| Max steps per idle run | `10 steps` | Caps maintenance slice to <150ms |
| Abort threshold | `backlog > 0` or `fps < 30` | Yields within 100ms on dispatch backlog or UI jank |

```js
// Budgeted idle vacuum loop
export async function runIncrementalVacuumBudget(storageEngine, { pagesPerStep = 50, maxSteps = 10 } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    if (syncManager.getDispatchBacklog() > 0 || performanceMonitor.getFps() < 30) {
      console.warn('[Storage] Yielding incremental vacuum due to dispatch backlog / low FPS');
      break;
    }
    const freed = await storageEngine.incrementalVacuum(pagesPerStep);
    if (freed === 0) break; // Freelist empty
    await yieldToMainThread();
  }
}
```

## Crash-Atomic Durability & Dirty-Boot Resurrection (ISP-067)

### Single Commit Order

```
1. SQLite WAL COMMIT  ──▶  2. OPFS syncfs  ──▶  3. IDB Mark Acked
```

1. **SQLite is the Source of Truth:** `BEGIN IMMEDIATE` transaction commits to WAL.
2. **OPFS syncfs ensures Durability:** File access handle commits bytes to disk.
3. **IndexedDB is Transport Journal:** Marks entry as `acked` after disk persistence.

### Resurrection Workflow (`crashRecovery.ts`)

On application boot after a crash, power outage, or kill:
1. **Torn WAL Tail Truncation:** Validate frame checksums and sequence continuity. Truncate torn tails and increment `torn_frames_dropped`.
2. **High-Water Alignment:**
   - Read `sqliteHighwater = storageEngine.getHighwater(deviceId)`.
   - Read `idbHighwater = journalStore.getHighwater(deviceId)`.
3. **Zombie-Snapshot Fencing:** If CRDT snapshot header carries `journal_highwater > sqliteHighwater` without IDB journal coverage, refuse snapshot restore (`zombie_snapshots_refused++`) to prevent deleted assignments from resurrecting.
4. **Strict Delta Replay:** Replay only IDB journal entries where `seq > sqliteHighwater`.
5. **WAL Checkpoint:** Execute `PRAGMA wal_checkpoint(TRUNCATE)`.
6. **Upload Gate Release:** Emit `RECOVERY_COMPLETE`. Network sync and crdtSync uploads remain blocked until this gate opens.

