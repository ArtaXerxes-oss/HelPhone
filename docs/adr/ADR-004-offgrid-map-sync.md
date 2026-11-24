# ADR-004: Off-Grid Incident Map Synchronization: State Vector Pruning vs OT Snapshots

- **Status:** Proposed (spike #604 complete)
- **Date:** 2026-09-23
- **Evidence:** [Spike report](../spikes/604-crdt-memory-analysis.md) · [raw results](../spikes/results/crdt-memory-profile.json) · `scripts/spikes/crdt_memory_profile.js`
**Evidence check:** `crdt-memory-profile.json#/singleDoc/stateVector_pruned/heapAfterPruneMB = 0.13`
- **Prototype:** `src/services/crdtSync.js` (`StateVectorDoc`, `OtServer`/`OtClient`)

## Context

Responders editing the incident map off-grid (responder coordinates, incident status) have to converge without a server. State-based CRDTs such as Yjs keep tombstones for every overwritten value. Over a long incident, that history grows without bound on low-spec mobile web views.

The spike replayed one deterministic stream of **50,000 mutations** across **20 replicas** through three engines. The stream was 83 % coordinate and incident writes, 15 % status patches and 2 % incident resolutions (deletes). It gossiped every 250 mutations and took 4 replicas offline for 3.6k–7.4k mutations each. The engines were:

1. A state-vector LWW-map CRDT with causal-stability pruning (this spike's prototype).
2. A light OT scheme with sequencer snapshots.
3. Real Yjs (`Y.Map`, `gc: true`) as the baseline.

## Decision drivers

1. Bounded memory per device across an incident of any length.
2. It must work with **no server and no fixed leader**: a mesh of intermittently connected phones.
3. Small reconnect payloads over weak links.
4. No GC pauses long enough to drop frames on the map.
5. Semantics must suit incidents: resolving an incident must not be undone by a stale device's edit.

## Results summary

| Per replica, after 50k mutations | Unpruned SV CRDT | **SV CRDT + pruning** | Yjs (gc on) | Light OT |
|---|---|---|---|---|
| Retained heap, mesh average | 5.79 MB | **0.09–0.20 MB** | 9.95 MB | 1.28 MB for all 21 parties, 0.40 MB sequencer |
| Single-document heap (50k overwrites of 300 keys) | 6.94 MB | **0.13 MB** | 11.45 MB | — |
| GC pauses across the run (max) | 116 ms | 54 ms (during prune) | **523 ms** | 3.8 ms |
| Reconnect payload avg / max | 81 / 153 KB | 24 / 42 KB (live pruning) | 27 / 47 KB (binary) | 30 / 35 KB |
| Rounds to converge after partitions heal | 3 | 3 | 3 | 1 (star) |
| Needs a single sequencer | no | **no** | no | **yes** |

Every engine converged. A 1,500-run fuzz test also confirms that pruned replicas end in exactly the state of an oracle computed from every op ever issued.

## Decision

1. **Adopt the delta-state LWW-map CRDT with causal-stability pruning (`StateVectorDoc`)** for the incident map. It is the only option that meets drivers 1 and 2 together: memory stays flat (about 0.1–0.2 MB per replica) and no device has to act as a leader.
2. **Pruning policy:**
   - *Log pruning* uses the stable state vector of the peers currently being synced with. Devices that fall behind that frontier get a snapshot containing only the entries they lack. This produced the smallest reconnect payloads measured: 24 KB on average.
   - *Delete tombstones* are dropped only when **both** of these hold:
     - The whole responder roster has seen the delete, judged from the last known state vectors.
     - Every client's stable prefix has a Lamport time at or above the tombstone's.

     The spike found two convergence bugs when either condition was missing. Both are now regression tests.
3. **Reject light OT as the primary model.** It had the lowest memory, but it needs a sequencer. Off-grid, that means the commander's phone: a single point of failure that every responder must reach. OT remains a fallback when a connected coordinator exists.
4. **Don't use Yjs for this structured map.** It needed 1.7× the unpruned CRDT's memory, 30 MB for a long-lived replica, pauses up to 523 ms and 10× the CPU time. Its concurrent-write semantics also resurrected resolved incidents: 876 live keys, against 492 under Lamport LWW. Yjs is still a reasonable choice for collaborative free text, which this data is not.

## Consequences

- **Positive:** Memory per device no longer depends on incident length. Pruning a 50k-op log takes about 1 ms. Any responder can sync with any other.
- **Negative:**
  - LWW resolves concurrent edits of the same field by Lamport order, so a concurrent status change can be lost. That is acceptable for position and status, but fields needing merge (notes, checklists) require a different CRDT.
  - Delete tombstones survive while any roster device is offline: 996 were retained in the live-pruning run. Their cost is small (about 100 bytes each), but a device lost for good must be **removed from the roster explicitly** to release them.
  - JSON wire encoding moved 50 MB of gossip in the run, against Yjs's 33 MB binary.
- **Follow-up work:**
  - A compact binary encoding (varints, key dictionary).
  - Carrying roster state vectors in gossip. The prototype reads them directly.
  - Wiring into the Help map page. The issue names `src/App.jsx`, but the map lives on `/help` and the landing page is now `App.tsx`, so this spike does not touch app UI.
  - A measurement on a real low-end Android WebView.

## Follow-up: binary gossip, roster vectors, roster removal (#894)

- **Evidence:** [raw results](../spikes/results/crdt-wire-894.json) from `node --expose-gc scripts/spikes/crdt_memory_profile.js --wire-only`, the same 50k-mutation, 20-replica live-pruning workload as above, run once over JSON and once over the binary wire.
- **Evidence check:** `crdt-wire-894.json#/mesh/1/gossipMB = 22.65`
- **Code:** `src/lib/crdtWire.js` (encoding), `src/services/incidentMapSync.js` (`IncidentMapReplica`, `connectReplica`), `src/features/help/IncidentMapSyncPanel.jsx` (wired into `/help`).

| Live-pruning mesh, 50k mutations | JSON | Binary (`crdtWire`) |
|---|---|---|
| Gossip moved | 45.33 MB | **22.65 MB** |
| Reconnect payload, average / max | 24.3 / 42.2 KB | **11.7 / 20.1 KB** |
| Converged | yes | yes |

The JSON figure in this run is 45 MB, against the 50 MB quoted above from the original spike run. The binary encoding halves it. That is below Yjs's 33 MB, for the same LWW semantics.

The single-document case was re-measured in the same run: pruning a 50k-op log over 300 keys took **0.6 ms**, and heap went from 6.94 MB to 0.13 MB, so memory stays flat as the incident grows.

What changed:

- **Encoding.** Messages use LEB128 varints, one string dictionary per message (keys, client ids, string values and property names each written once), and per-client delta-coded clocks and Lamport times. `-0` is written as `0`, as JSON does, so replicas on either transport hold identical state.
- **Roster state vectors in gossip.** Every message carries the sender's vector and its last known vector for every other roster member. Vectors are merged by element-wise maximum, so each stays a lower bound. Tombstones are released only when a vector is known for every roster member.
- **Roster removal.** The roster lives in the document as `__roster/<id>` keys, so a removal propagates like any other op. Ops written by a removed device are discarded from then on, including ops relayed by other peers, so they are left out of pruning rule 2 and a lost device's tombstones are released. The removed id is remembered outside the document, because the roster delete is itself a tombstone and is pruned eventually.
- **Trade-off, stated:** an op the lost device still had in flight when it was removed is discarded. Remove only devices known to be lost; a device that returns must rejoin under a new id.
- **Still pinned by silence:** a roster member that is alive but never writes still holds tombstones under rule 2 until its next write. Responders write their position periodically, which moves them past the deletes.

**Not done:** the measurement on a real low-end Android WebView. The numbers above are from Node 22 on a laptop.
