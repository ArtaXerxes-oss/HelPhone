# Architecture Decision Records — HelPhone

Each ADR records one architecture decision: its context, the options
considered, the evidence gathered (spike reports, benchmarks, legal analysis),
and the consequences of the chosen direction. ADRs produced by time-boxed
feasibility spikes link to the spike report in [`docs/spikes/`](../spikes/README.md).

**An ADR is required for every ISP-1xx spike outcome before the spike branch
merges.** If the decision is deferred, the ADR still ships — with status
*Deferred*, an expiry date, and a named decision owner.

---

## Index

| ADR | Title | Status | ISP / Spike |
|---|---|---|---|
| [ADR-001](ADR-001-soroban-incident-storage.md) | Soroban Incident Storage: Packed vs Normalised Persistent Ledger Entries | Accepted | — |
| [ADR-002](ADR-002-wasm-memory-isolation.md) | WASM Memory Isolation: Linear-Memory Sandbox vs Shared ArrayBuffer | Accepted | — |
| [ADR-003](ADR-003-webtransport-vs-websocket.md) | WebTransport vs WebSocket for Real-Time Dispatch | Accepted | — |
| [ADR-004](ADR-004-offgrid-map-sync.md) | Off-Grid Incident Map Synchronisation: State-Vector Pruning vs OT Snapshots | Proposed | #604 |
| [ADR-005](ADR-005-zk-proof-aggregation.md) | Client-Side ZK Proof Aggregation: Feasibility & Resource Limits | Proposed | #605 |
| [ADR-006](ADR-006-offline-routing.md) | Offline Client-Side Routing: Algorithm & Vector Data Format | Proposed | #606 |
| [ADR-007](ADR-007-offline-storage.md) | High-Throughput Offline Client Storage: IndexedDB vs OPFS SQLite WASM | Proposed | #607 |
| [ADR-008](ADR-008-webgpu-spatial-clustering.md) | WebGPU Spatial Clustering for Map Overlays | Proposed | #608 |
| [ADR-014](ADR-014-binary-telemetry-protocol.md) | Binary Protocol for Zero-Jank Telemetry Map Streams | Proposed | #614 |
| [ADR-015](ADR-015-tokenomics-fee-envelope.md) | Tokenomics: Fee Envelope, Sustainability Reserve & Maintainer Grant Model | Proposed | ISP-141 |
| [ADR-016](ADR-016-attestation-cryptography.md) | Responder Attestation Cryptography: ZK Credential vs On-Chain Registry | Proposed | ISP-142 |
| [ADR-017](ADR-017-multi-tenant-database.md) | Multi-Tenant Database Architecture: RLS Policy Design & Partition Strategy | Proposed | ISP-143 |
| [ADR-018](ADR-018-centerless-federation.md) | Centerless Federation Protocol: Gossip Topology & Conflict-Resolution Model | Proposed | ISP-144 |
| [ADR-019](ADR-019-compulsion-law-halt-doctrine.md) | Compulsion-Law Halt Doctrine: Jurisdiction-Triggered Data Isolation | Proposed | ISP-145 |
| [ADR-020](ADR-020-triage-ethics-shedding-order.md) | Triage Ethics & Load-Shedding Order Under Overload | Proposed | ISP-146 |
| [ADR-021](ADR-021-multi-vendor-cost-control.md) | Multi-Vendor Cost Control: Spending Envelopes & Kill-Switch Protocol | Proposed | ISP-147 |
| [ADR-022](ADR-022-honest-dispatch-eta.md) | Honest Dispatch ETA: Ranges, Fatigue Pace, and Degraded-State Signalling | Proposed | ISP-105 / #775 |

---

## Done-definition for new ADRs

A spike PR is not mergeable until its ADR satisfies all of:

- [ ] Status is one of: *Proposed*, *Accepted*, *Superseded by ADR-NNN*, *Deferred (expires YYYY-QN, owner: @handle)*.
- [ ] Context section names the forcing function (ISP ticket, live incident, legal deadline).
- [ ] Options considered: at least two alternatives with their trade-offs stated quantitatively where evidence exists.
- [ ] Decision section states what was chosen and why, referencing benchmark data or legal analysis by file path.
- [ ] Consequences section names the subsystems affected and the follow-up actions with owners and due dates.
- [ ] Added to the index table in this README.
- [ ] CODEOWNERS review obtained for `docs/adr/` path (requires `@helphone-maintainers`).

---

## Template

Copy `ADR-000-template.md` for every new record:

```
cp docs/adr/ADR-000-template.md docs/adr/ADR-NNN-short-title.md
```

---

## Subsystem coverage map

| Subsystem | ADRs covering it | Gap |
|---|---|---|
| Soroban Contracts | ADR-001, ADR-015, ADR-016, ADR-021 | Cost envelopes per contract (→ADR-021) |
| Indexer / DB | ADR-017 | Partition eviction policy |
| ZK / Circuits | ADR-002, ADR-005, ADR-016 | Proving-key lifecycle |
| PWA / Offline | ADR-004, ADR-006, ADR-007 | Quota exhaustion |
| Maps / WebGPU | ADR-008 | Shader cross-browser fallback |
| Dispatch / WS | ADR-003 | Priority queue under overload (→ADR-020) |
| Telemetry | ADR-014 | WASM reader versioning |
| DAO / Treasury | ADR-015, ADR-021 | Governance quorum calculation |
| Federation | ADR-018 | Trust-anchor bootstrapping |
| Legal / Compulsion | ADR-019 | Per-jurisdiction envelopes |
| Triage Ethics | ADR-020 | Liability sign-off |
