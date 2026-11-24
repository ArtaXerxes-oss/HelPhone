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

This table is generated from ADR files. After editing an ADR, run
`node scripts/adr-review.mjs --write`; CI checks it with `--check`.
The scheduled ADR review workflow opens a reminder during the final 30 days
of a deferred decision's expiry quarter and publishes a quarterly report of
unchecked CODEOWNERS review items.

<!-- ADR-INDEX-START -->
| ADR | Title | Status | ISP / Spike |
|---|---|---|---|
| [ADR-001](ADR-001-soroban-incident-storage.md) | Soroban Incident State Storage Architecture: Bit-Packed Storage vs Normalized Ledger Records | Proposed | #601 (time box 3 days) |
| [ADR-002](ADR-002-wasm-memory-isolation.md) | WASM Memory Isolation Strategy for Client-Side Encrypted Payloads | Proposed | #602 (time box 2 days) |
| [ADR-003](ADR-003-webtransport-vs-websocket.md) | WebTransport vs WebSocket Protocol Selection for Disaster Network Conditions | Proposed | #603 (time box 4 days) |
| [ADR-004](ADR-004-offgrid-map-sync.md) | Off-Grid Incident Map Synchronization: State Vector Pruning vs OT Snapshots | Proposed (spike #604 complete) | — |
| [ADR-005](ADR-005-zk-proof-aggregation.md) | Client-Side ZK Proof Aggregation Feasibility & Resource Allocation Limits | Proposed (spike #605 complete) | — |
| [ADR-006](ADR-006-offline-routing.md) | Offline Client-Side Routing Algorithm & Vector Data Format Selection | Proposed (spike #606 complete) | — |
| [ADR-007](ADR-007-offline-storage.md) | High-Throughput Offline Client Storage: IndexedDB vs OPFS SQLite WASM | Proposed (spike #607 complete; quota/eviction measurement outstanding, see below) | — |
| [ADR-008](ADR-008-webgpu-spatial-clustering.md) | WebGPU-accelerated spatial clustering for high-density emergency maps | Proposed (feasibility spike [#608](https://github.com/Hel-Phone/HelPhone/issues/608)) | — |
| [ADR-014](ADR-014-binary-telemetry-protocol.md) | Binary Protocol Selection for Zero-Jank Telemetry Map Streams | Proposed (feasibility spike [#614](https://github.com/Hel-Phone/HelPhone/issues/614)) | — |
| [ADR-014](ADR-014-telemetry-binary-frames.md) | Binary telemetry frames for the live map | Accepted · **Owner:** @helphone-telemetry-owner / @helphone-maps-owner | — |
| [ADR-015](ADR-015-tokenomics-fee-envelope.md) | Tokenomics: Fee Envelope, Sustainability Reserve & Maintainer Grant Model | Proposed | ISP-141 |
| [ADR-016](ADR-016-attestation-cryptography.md) | Responder Attestation Cryptography: ZK Credential vs On-Chain Registry | Proposed | ISP-142 |
| [ADR-017](ADR-017-multi-tenant-database.md) | Multi-Tenant Database Architecture: RLS Policy Design & Partition Strategy | Proposed | ISP-143 |
| [ADR-018](ADR-018-centerless-federation.md) | Centerless Federation Protocol: Gossip Topology & Conflict-Resolution Model | Proposed | ISP-144 |
| [ADR-019](ADR-019-compulsion-law-halt-doctrine.md) | Compulsion-Law Halt Doctrine: Jurisdiction-Triggered Data Isolation | Proposed | ISP-145 |
| [ADR-020](ADR-020-triage-ethics-shedding-order.md) | Triage Ethics & Load-Shedding Order Under Overload | Proposed | ISP-146 |
| [ADR-021](ADR-021-multi-vendor-cost-control.md) | Multi-Vendor Cost Control: Spending Envelopes & Kill-Switch Protocol | Proposed | ISP-147 |
| [ADR-022](ADR-022-ble-proximity-relay.md) | BLE Proximity Relay: Authenticated Beacon Format & Shippable-Scope Decision | Deferred (expires 2027-Q1, owner: @helphone-pwa-owner) | ISP-113 / #783 |
| [ADR-022](ADR-022-eta-ranges-and-calibration.md) | Bounded ETA ranges, degraded display and calibration | Accepted · **Owner:** @helphone-maintainers | — |
| [ADR-022](ADR-022-honest-dispatch-eta.md) | Honest Dispatch ETA: Ranges, Fatigue Pace, and Degraded-State Signalling | Proposed | ISP-105 / #775 |
| [ADR-023](ADR-023-canonical-contract-workspace.md) | Canonical Soroban Contract Workspace | Proposed | #980 |
| [ADR-024](ADR-024-matrix-call-caching-quota.md) | Matrix Call Caching and Quota Policy | Proposed | — |
| [ADR-025](ADR-025-liability-signoff-workflow.md) | Liability Sign-off for Triage Shedding | Proposed | — |
| [ADR-026](ADR-026-uv-tier-policy.md) | UV-tier policy for sensitive endpoints | Accepted (enforcement on the protected route and session-bound GraphQL mutations; remaining routes listed below as follow-up) | ISP-059 / #729, issue #924 |
| [ADR-027](ADR-027-twin-module-canonicalization.md) | One canonical module per name (`.js`/`.ts` twins) | Accepted | #901 |
<!-- ADR-INDEX-END -->

## Evidence status

<!-- ADR-EVIDENCE-START -->
| ADR | Evidence status |
|---|---|
| [ADR-001](ADR-001-soroban-incident-storage.md) | No raw result cited |
| [ADR-002](ADR-002-wasm-memory-isolation.md) | No raw result cited |
| [ADR-003](ADR-003-webtransport-vs-websocket.md) | Checked (1 result) |
| [ADR-004](ADR-004-offgrid-map-sync.md) | Checked (2 results) |
| [ADR-005](ADR-005-zk-proof-aggregation.md) | Checked (1 result) |
| [ADR-006](ADR-006-offline-routing.md) | Checked (3 results) |
| [ADR-007](ADR-007-offline-storage.md) | Checked (4 results) |
| [ADR-008](ADR-008-webgpu-spatial-clustering.md) | No raw result cited |
| [ADR-014](ADR-014-binary-telemetry-protocol.md) | Checked (4 results) |
| [ADR-015](ADR-015-tokenomics-fee-envelope.md) | No raw result cited |
| [ADR-016](ADR-016-attestation-cryptography.md) | No raw result cited |
| [ADR-017](ADR-017-multi-tenant-database.md) | No raw result cited |
| [ADR-018](ADR-018-centerless-federation.md) | No raw result cited |
| [ADR-019](ADR-019-compulsion-law-halt-doctrine.md) | No raw result cited |
| [ADR-020](ADR-020-triage-ethics-shedding-order.md) | No raw result cited |
| [ADR-021](ADR-021-multi-vendor-cost-control.md) | No raw result cited |
| [ADR-022](ADR-022-ble-proximity-relay.md) | No raw result cited |
| [ADR-022](ADR-022-honest-dispatch-eta.md) | Unmeasured |
| [ADR-023](ADR-023-canonical-contract-workspace.md) | No raw result cited |
| [ADR-024](ADR-024-matrix-call-caching-quota.md) | No raw result cited |
| [ADR-025](ADR-025-liability-signoff-workflow.md) | No raw result cited |
| [ADR-026](ADR-026-uv-tier-policy.md) | No raw result cited |
<!-- ADR-EVIDENCE-END -->

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
