# Spike #604: CRDT vs OT Memory, Heap Snapshot & Trade-off Analysis

Feeds [ADR-004](../adr/ADR-004-offgrid-map-sync.md). Raw numbers: [`results/crdt-memory-profile.json`](results/crdt-memory-profile.json).

## What was built

| File | Purpose |
|---|---|
| `src/services/crdtSync.js` | `StateVectorDoc`: a delta-state LWW-map CRDT with state vectors, gap buffering, content GC, causal-stability pruning and filtered snapshot fallback. `OtServer` / `OtClient`: a light OT sequencer with transform, log compaction, snapshot catch-up and offline-queue coalescing. |
| `scripts/spikes/crdt_memory_profile.js` | Replays one 50k-mutation workload through five engines: 3 CRDT pruning policies, Yjs and OT. Measures retained heap, GC pauses, payloads and convergence. `--heap-snapshots` adds V8 heap-snapshot breakdowns. |
| `test/crdt-sync.test.js` | 19 tests, including 2 regression tests for convergence bugs this spike found, and fuzz tests comparing pruned replicas to an oracle computed from every op issued. |

## Workload

- **50,000 mutations** from 20 replicas:
  - 41,270 sets: 80 % responder coordinate updates, plus incident creates.
  - 7,509 incident status patches.
  - 1,221 incident resolutions (deletes).
- 300 responders, up to 150 live incidents.
- **Gossip:** every 250 mutations, each online replica syncs both ways with one random online peer.
- **Partitions:** 4 replicas go offline for windows of 3.6k–7.4k mutations and keep editing locally.
- **Pruning:** every 2,500 mutations for the pruning variants.
- **Heal:** at the end all replicas come online and gossip until their state digests match.
- **Machine:** i5-4300U, Node 22.22 `--expose-gc`. Heap figures are `heapUsed` after two forced GCs. GC pauses exclude forced collections.

Reproduce: `npm run spike:crdt`.

## Results

### 1. One replica, 50k overwrites of 300 keys (pure tombstone growth)

| Engine | Retained heap | Encoded full state | Notes |
|---|---|---|---|
| SV CRDT, content kept | 10.70 MB | 26.8 KB | 49,700 tombstones in the log |
| SV CRDT, content GC (default) | 6.94 MB | 26.8 KB | superseded values nulled, ids kept |
| **SV CRDT after `prune()`** | **0.13 MB** | 26.8 KB | prune took 0.9 ms |
| Yjs `gc: true` | 11.45 MB | 481 KB | |
| Yjs `gc: false` | 17.54 MB | 2,124 KB | |

### 2. V8 heap-snapshot breakdown (shallow sizes, same single document)

Top object groups over a 15.9 MB process baseline:

| Snapshot | Total | What the growth is made of |
|---|---|---|
| SV CRDT, unpruned | 22.8 MB (+6.9) | +50,311 `Object` (op records, +3.4 MB), +50k strings (keys and client ids, +1.1 MB), +50k hidden-class slots (+1.9 MB) |
| SV CRDT, pruned | 16.0 MB (+0.1) | indistinguishable from baseline: only 300 winning entries remain |
| Yjs `gc: true` | 26.3 MB (+10.4) | 49,844 `Item` (5.3 MB) + 50,001 `ID` (1.9 MB) + 49,544 `ContentDeleted` (1.5 MB): one struct chain per historical write, even with GC on |

Yjs's GC replaces *content* but keeps the `Item` / `ID` skeleton so it can keep merging with peers that may hold older state. That skeleton is the unbounded part. The prototype removes it by agreeing on a causally stable frontier.

### 3. Mesh of 20 replicas, full workload

| Engine | Heap, all replicas | Heap per replica | Max GC pause (GCs, total) | CPU for workload + gossip | Reconnect payload avg / max | Converged |
|---|---|---|---|---|---|---|
| crdt-nogc | 115.7 MB | 5.79 MB | 116 ms (41, 2.6 s) | 4.0 s | 81 / 153 KB | ✔ 3 rounds, 99 ms |
| crdt-prune-all | 1.7 MB | 0.09 MB | 54 ms during a prune | 3.8 s | 81 / 153 KB | ✔ 3 rounds, 77 ms |
| **crdt-prune-live** | 3.9 MB | 0.20 MB | 54 ms during a prune | 2.5 s | **24 / 42 KB** | ✔ 3 rounds, 78 ms |
| Yjs (gc on) | 199.0 MB | 9.95 MB | **523 ms** (174, 8.9 s) | **36.5 s** | 27 / 47 KB (binary) | ✔ 3 rounds, 1,069 ms |
| OT + snapshots | 1.3 MB (sequencer 0.40 MB) | — | 3.8 ms (9, 29 ms) | 1.6 s | 30 / 35 KB | ✔ 1 round, 30 ms |

Other measurements:

- **Gossip traffic:** SV CRDT 50 MB (JSON); Yjs 33 MB (binary); OT 79 MB (star topology, every client syncs with the sequencer each round).
- **Retained tombstones:** replica 0 after convergence held 47,698 log tombstones unpruned, 0 with pruning.
  - prune-all: 3 delete tombstones.
  - prune-live: 996 delete tombstones. They stay until every roster device has seen the delete.
- **OT sequencer:** compacted 49 times. Its log never exceeded 5,000 ops (707 at the end). Clients coalesced an average of 56 and at most 113 queued offline ops per reconnect.
- **OT catch-up:** a long-offline client first received 233 KB of op replay. Once the sequencer sent the snapshot whenever it was smaller, this dropped to 30 KB. That change is in the prototype.

### 4. Semantics

Final live keys: 492 for the LWW-Lamport engines, **876 for Yjs**. Yjs lets a concurrent write from a stale device survive an earlier delete, so offline responders' status edits resurrected incidents that had already been resolved. Under LWW-Lamport the resolution wins unless the edit is causally newer. For incident data that is the desired behaviour.

## Bugs found and fixed during the spike

The fuzz test and profiler found two convergence bugs in naive tombstone pruning. Both are now regression tests.

1. **Resurrection by in-flight writes.** Dropping a delete once every peer had *seen* it isn't enough. A set that a peer made *before* seeing the delete can still be in flight, and it resurrects the key only on replicas that had pruned. **Fix:** a Lamport horizon. Keep a tombstone until every client's stable prefix has a Lamport time at or above it. Anything still undelivered then outranks the delete everywhere.
2. **Divergence after eviction.** When live members pruned at their own frontier, a device that was offline never learned about deletes, and after reconnecting kept its stale values permanently. `prune-live` failed to converge until this was fixed. **Fix:** log pruning may use the live frontier, but tombstones require stability over the **whole roster** (last known state vectors).

After both fixes, 1,500 randomized runs (500 seeds × 3 pruning modes, 5 replicas × 500 steps) all matched the oracle.

## Trade-offs

| | SV CRDT + pruning | Light OT + snapshots | Yjs |
|---|---|---|---|
| Works leaderless / mesh | ✔ | ✘ needs a reachable sequencer | ✔ |
| Memory bound | ✔ frontier-bounded | ✔ snapshot-bounded | ✘ grows with history |
| GC behaviour | small, periodic | minimal | long pauses |
| Wire size | medium (JSON today) | small catch-ups, but a round trip per sync | smallest (binary) |
| Rich merge (text, lists) | ✘ LWW per key | partial (custom transforms) | ✔ |
| Complexity | moderate: pruning rules are subtle (see bugs above) | moderate: transform functions per op type | low: library |

## Limitations

- All numbers come from Node on a laptop CPU. A low-end Android WebView will be slower and may GC more aggressively. The *ratios* between engines are the useful signal.
- The profiler reads offline replicas' state vectors directly. Production must carry them in gossip; they are last-known values, which is also safe.
- Wire sizes are JSON. A binary encoding would roughly halve CRDT traffic.
