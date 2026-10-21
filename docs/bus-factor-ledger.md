# Bus-Factor Ledger — HelPhone

A bus factor of N for a subsystem means N people can independently operate and
recover that subsystem without help. Bus factor 1 means one departure makes the
subsystem unrecoverable without a significant scramble.

**This ledger is a living document.** It is reviewed and updated each quarter
(January, April, July, October) as part of the CODEOWNERS review cycle. The
review owner is `@helphone-maintainers`.

**Measurement standard:** Bus factor is not self-reported availability — it is
validated by the ability to execute the subsystem's graduation drill (see
`docs/first-spike-program.md#graduation-drills`) independently. An undrilled
backup counts as 0.5, not 1.

Last updated: 2026-10-16
Next review: 2027-01-16

---

## Summary dashboard

| Subsystem | Current factor | Target (Q1 2027) | Worst risk |
|---|---|---|---|
| App / UI | 2 | 3 | Low — broad skill set |
| Soroban Contracts | **1** | 2 | **CRITICAL** — single deployer |
| Indexer / DB | **1** | 2 | **CRITICAL** — lag-spike recovery |
| ZK / Circuits | **1** | 2 | **CRITICAL** — exotic skill |
| PWA / Offline | 2 | 3 | Medium — CRDT reasoning |
| Maps / WebGPU | **1** | 2 | High — shader expertise |
| Dispatch / WS | 2 | 2 | Medium — met target |
| Telemetry | **1** | 2 | High — binary schema |
| Security Infrastructure | 2 | 3 | Medium |

**4 of 9 subsystems are at bus-factor 1. All four have dated mitigation plans below.**

---

## Per-subsystem detail

### App / UI

**Files:** `src/App.tsx`, `src/pages/`, `src/components/`, `src/styles/`

| | |
|---|---|
| Current bus factor | 2 |
| Target | 3 |
| Primary owner | @helphone-ui-owner |
| Named backup | @helphone-ui-backup |
| Backup drilled? | Yes |
| Target date | 2027-Q1 |

**What "independently operate" means:** Can diagnose and fix a layout regression
caught by `tests/e2e/layout.spec.ts`, ship an accessibility fix, and deploy a
UI change through the full CI cycle without assistance.

**Mitigation to reach factor 3:** Route Stage 1 first-spike contributors
(see `docs/onboarding-ladder.md`) to the UI subsystem first. First-spike
graduates become backup candidates after their second merged PR.

---

### Soroban Contracts ⚠️ CRITICAL (factor 1)

**Files:** `contracts/aegis_vault/`, `contracts/emergency_vault/`,
`contracts/helphone_dao/`, `contracts/maintainer_vault/`,
`src/lib/contract.ts`, `src/lib/footprint.ts`, `src/lib/txBatcher.ts`

| | |
|---|---|
| Current bus factor | **1** |
| Target | 2 |
| Primary owner | @helphone-contract-owner |
| Named backup | *VACANT* |
| Backup drilled? | No |
| Target date | **2027-Q1 (hard deadline)** |

**What "independently operate" means:** Can deploy a contract to Stellar testnet
via `scripts/deploy-local-contract.sh`, execute a storage migration, diagnose
a footprint budget overflow (via `test/footprint-inspection.test.js`), and
regenerate bindings via `scripts/generate-soroban-bindings.js`.

**Mitigation:**
1. (Immediate) Route one Stage 3 first-spike contributor to the contract track.
2. (2026-Q4) Complete ADR-015 `teaching_bps` implementation — this forces a
   second person to understand the contract storage model.
3. (2027-Q1) Graduation drill: testnet contract upgrade with state migration.
   Must be executed by the backup candidate before the deadline.

**Funded by:** `contracts/helphone_dao/src/sustainability.rs` `teaching_bps`
allocation (ADR-015). Mentor hours budgeted in `docs/first-spike-program.md`.

---

### Indexer / DB ⚠️ CRITICAL (factor 1)

**Files:** `server/indexer/daemon.ts`, `server/indexer/parser.ts`,
`server/indexer/exporter.ts`, `server/indexer/auditStreamer.js`,
`server/indexer/rentRenewer.ts`, `server/db/poolManager.ts`,
`server/db/connection.ts`, `server/db/migrator.ts`, `server/db/partitioning.js`,
`migrations/`

| | |
|---|---|
| Current bus factor | **1** |
| Target | 2 |
| Primary owner | @helphone-db-owner |
| Named backup | *VACANT* |
| Backup drilled? | No |
| Target date | **2027-Q1 (hard deadline)** |

**What "independently operate" means:** Can diagnose an indexer lag spike
(identify whether it is pool exhaustion, slow query, or Soroban RPC backpressure),
execute a database migration via `server/db/migrator.ts`, and run
`scripts/export-contract-state.sh` for a disaster-recovery snapshot.

**Mitigation:**
1. (Immediate) Pair a Stage 2 contributor with the DB owner on the next
   migration (ADR-017 `withTenant` wrapper work).
2. (2026-Q4) Write the pool exhaustion runbook section in
   `docs/disaster-recovery.md`.
3. (2027-Q1) Graduation drill: simulate a lag spike in staging, diagnose,
   and restore without the primary owner.

---

### ZK / Circuits ⚠️ CRITICAL (factor 1)

**Files:** `circuits/`, `src/lib/zk.ts`, `src/lib/provers.js`,
`src/services/zkProver.ts`, `src/services/zkProofCache.js`,
`src/workers/zk-worker.js`, `docs/zk-design.md`

| | |
|---|---|
| Current bus factor | **1** |
| Target | 2 |
| Primary owner | @helphone-zk-owner |
| Named backup | *VACANT* |
| Backup drilled? | No |
| Target date | **2027-Q2** |
| External reviewer | *TBD (fellowship program — see `docs/first-spike-program.md`)* |

**What "independently operate" means:** Can compile a Noir circuit with `nargo`,
run a local proof generation via `circuits/scripts/benchmark.sh`, diagnose a
proving-key version mismatch, and update `src/wasm/` artifacts via
`scripts/verify-wasm-build.sh`.

**Mitigation:**
1. (Immediate) Initiate ZK fellowship track (see `docs/first-spike-program.md#zk-track`).
   This is an external hire / fellowship candidate track — not an internal
   rotation, because the skill requires specific training.
2. (2026-Q4) External ZK audit relationship: establish a paid review budget
   with a ZK consultancy for code review coverage during the fellowship gap.
3. (2027-Q2) Graduation drill: complete the ADR-016 credential circuit
   (`circuits/responder_credential/`) independently.

**Note:** This is the highest-risk subsystem. Bus factor 1 on ZK means a single
illness during a disaster-season code change could block all privacy proofs.
The external audit relationship is a non-negotiable bridge until the fellowship
produces an internal backup.

---

### PWA / Offline

**Files:** `src/service-worker.js`, `src/lib/syncManager.ts`, `src/lib/crdt.ts`,
`src/services/crdtSync.js`, `src/services/storageEngine.js`

| | |
|---|---|
| Current bus factor | 2 |
| Target | 3 |
| Primary owner | @helphone-pwa-owner |
| Named backup | @helphone-pwa-backup |
| Backup drilled? | Yes (partial — CRDT partition-heal not yet drilled) |
| Target date | 2027-Q1 |

**What "independently operate" means:** Can diagnose a CRDT merge divergence
(using `test/crdt-sync.test.js`), update the service worker cache strategy,
and verify offline-first behaviour using the `tests/e2e/throttling.spec.ts`
offline profile.

**Mitigation:** CRDT partition-heal graduation drill scheduled for 2027-Q1.

---

### Maps / WebGPU ⚠️ HIGH RISK (factor 1)

**Files:** `src/components/WebGPUMap.jsx`, `src/shaders/clusterShader.wgsl`,
`src/lib/offscreenCanvas.ts`, `src/workers/cluster-worker.js`

| | |
|---|---|
| Current bus factor | **1** |
| Target | 2 |
| Primary owner | @helphone-maps-owner |
| Named backup | *VACANT* |
| Backup drilled? | No |
| Target date | **2027-Q1** |

**What "independently operate" means:** Can debug a shader compilation failure
(using `test/spatial-cluster.test.js`), diagnose an OffscreenCanvas memory
leak, and verify the software fallback path.

**Mitigation:**
1. (2026-Q4) Route a Stage 3 contributor with WebGL/WebGPU interest to the
   maps subsystem.
2. (2027-Q1) Graduation drill: reproduce and fix a GPU-tier fallback regression
   on the software-rendering path.

---

### Dispatch / WebSocket

**Files:** `server/routes/dispatch.ts`, `server/routes/wsCluster.js`,
`server/lib/redisPubSub.js`

| | |
|---|---|
| Current bus factor | 2 |
| Target | 2 (met) |
| Primary owner | @helphone-dispatch-owner |
| Named backup | @helphone-dispatch-backup |
| Backup drilled? | Yes |
| Target date | — |

**Note:** Bus-factor target met. Continue quarterly drill verification.
ADR-020 priority queue implementation (2026-Q4) may change this assessment.

---

### Telemetry ⚠️ HIGH RISK (factor 1)

**Files:** `src/workers/telemetryWorker.js`, `src/wasm/telemetry_reader/`,
`src/schemas/telemetry.fbs`, `src/schemas/telemetry.capnp`,
`src/utils/binaryParser.js`

| | |
|---|---|
| Current bus factor | **1** |
| Target | 2 |
| Primary owner | @helphone-telemetry-owner |
| Named backup | *VACANT* |
| Backup drilled? | No |
| Target date | **2027-Q1** |

**What "independently operate" means:** Can update a FlatBuffers schema in
`src/schemas/telemetry.fbs`, regenerate the WASM reader, verify the SHA-256
in `src/wasm/telemetry_reader.wasm.sha256`, and diagnose a ring-buffer overflow
in `test/ring-buffer.test.js`.

**Mitigation:**
1. (2026-Q4) Document the binary schema upgrade procedure in `docs/telemetry-architecture.md`.
2. (2027-Q1) Graduation drill: schema migration from FlatBuffers v1 to v2
   with backward-compatible reader.

---

### Security Infrastructure

**Files:** `server/middleware/auth.ts`, `src/lib/crypto.ts`,
`scripts/security/`, `config/maintainer-keys.json`

| | |
|---|---|
| Current bus factor | 2 |
| Target | 3 |
| Primary owner | @helphone-security-owner |
| Named backup | @helphone-maintainers (collective) |
| Backup drilled? | Partially |
| Target date | 2027-Q2 |

**Mitigation:** Third qualified reviewer needed for key-rotation events.
Route a Stage 3 contributor with security interest to the security track
after completing the first-spike program.

---

## Quarterly refresh procedure

At the start of each quarter (January, April, July, October):

1. For each bus-factor-1 subsystem: verify the mitigation action was executed.
   If not, escalate to the DAO with a new deadline and funding request.
2. For each named backup: confirm they can still execute the graduation drill.
   Re-drill if more than 6 months have passed.
3. Update this table with new dates and names.
4. If any subsystem has reached its target factor, mark it as met and stop
   the mitigation clock.
5. Open a PR with the updated ledger. Requires `@helphone-maintainers` approval.

Refresh is a DAO-visible metric tracked in the monthly demo ritual
(see `docs/first-spike-program.md#demo-ritual`).
