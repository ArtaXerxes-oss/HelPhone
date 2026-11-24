# First-Spike Program — HelPhone

The first-spike program is how HelPhone grows the experts it needs rather than
hoping to hire them during a disaster season. It converts a willing contributor
into someone who can safely operate a critical subsystem — and pays them for
that journey.

This document covers:
1. Program structure and mentor rotation
2. Paid hours and DAO funding mechanism
3. Monthly demo ritual
4. Conversion metric
5. Graduation drills per exotic track
6. DAO funding proposal

---

## 1. Program structure

### Tracks

| Track | Target subsystem | Min prerequisite | Current mentor |
|---|---|---|---|
| **General** | App / UI, API | None | @helphone-ui-owner |
| **Indexer / DB** | `server/db/`, `migrations/` | Stage 2 complete | @helphone-db-owner |
| **Contract** | `contracts/`, `src/lib/contract.ts` | Stage 2 complete | @helphone-contract-owner |
| **ZK / Circuits** | `circuits/`, `src/lib/zk.ts` | Stage 3 complete | @helphone-zk-owner |
| **PWA / Offline** | `src/service-worker.js`, `src/lib/crdt.ts` | Stage 1 complete | @helphone-pwa-owner |
| **Maps / WebGPU** | `src/shaders/`, `src/components/WebGPUMap.jsx` | Stage 1 complete | @helphone-maps-owner |

### Time-box per track

| Track | Spike hours (paid) | Expected output |
|---|---|---|
| General | 8 h | Merged Stage 1 or Stage 2 PR |
| Indexer / DB | 16 h | Merged Stage 3 PR with test coverage |
| Contract | 24 h | Merged Stage 3 PR + local sandbox deploy |
| ZK / Circuits | 40 h | Completed Noir circuit modification + proof test |
| PWA / Offline | 16 h | Merged CRDT change with convergence test |
| Maps / WebGPU | 16 h | Merged shader or OffscreenCanvas change with FPS test |

Hours are paid via `contracts/helphone_dao/src/sustainability.rs` `teaching_bps`
allocation (see ADR-015 and the DAO funding proposal below).

### Eligibility

- Any contributor who has completed at least one open-source pull request
  (anywhere, any project) is eligible for any track.
- For ZK and Contract tracks: demonstrated familiarity with Rust or
  Noir/Halo2 is required (a portfolio link suffices; no test required).
- Applications are open quarterly. The review panel is the existing mentor
  for the track plus one other CODEOWNERS-listed maintainer.

---

## 2. Mentor rotation

Each track has a primary mentor and a target backup. When a backup qualifies
via graduation drill, they rotate into a co-mentor role, and the primary mentor
can take one quarter's leave from that track.

**Mentor load cap:** A mentor may hold at most 2 active first-spike participants
simultaneously. Exceeding this cap requires DAO approval for an additional
mentor stipend.

**Mentor obligations per spike:**

1. Kick-off call (1 h): explain the task, the codebase context, and the
   graduation drill for the track.
2. Mid-spike check-in (30 min): unblock the participant, not do the work for them.
3. PR review (1–2 h): full review using `docs/review-policy.md` checklist.
4. Demo prep (30 min): help the participant prepare their 5-minute demo.

Total mentor time per spike: ~4–6 hours. This is the paid work budgeted in the
DAO proposal.

---

## 3. Monthly demo ritual {#demo-ritual}

**Slot:** Last Thursday of each month, 30 minutes, recorded.

**Format:**
- Each participant who completed a spike presents for 5 minutes max:
  - What did I change?
  - What did I learn about the subsystem?
  - What would I do differently?
- Mentors comment for 2 minutes.
- The recording is posted to the project's public communication channel.

**Purpose:**
- Creates social proof that the first-spike program produces real changes.
- Surfaces subsystem knowledge that is otherwise in one person's head.
- Generates the conversion metric data (see below).

**Scheduling owner:** `@helphone-maintainers`. If the slot is not scheduled
within 2 weeks of a spike completing, the program is considered at risk — this
is a signal to the DAO that mentor load is too high.

---

## 4. Conversion metric

The conversion metric tracks whether the first-spike program is producing
operational depth, not just merged PRs.

**Primary metric:** Fraction of first-spike graduates who complete a second
spike *without hand-holding* within 6 months of their first.

**Target:** ≥50% of graduates complete a second spike within 6 months.

**Secondary metrics:**
- Time from first PR to first reviewed-merge (target: <24 h for Stage 1/2).
- Number of bus-factor-1 subsystems (target: 0 by 2027-Q2 per
  `docs/bus-factor-ledger.md`).
- Number of graduation drills completed per quarter (target: ≥1 per
  bus-factor-critical subsystem per quarter).

**Dashboard:** Maintained in this document's appendix (updated quarterly by
`@helphone-maintainers`).

---

## 5. Graduation drills per exotic track {#graduation-drills}

Graduation drills are live exercises, not written tests. They are designed to
be hard enough to mean something without requiring the very expertise the
program is trying to grow. Each drill is witnessed by the primary mentor.

### General track

No formal graduation drill required. Second spike without hand-holding is
sufficient to qualify as a UI or API backup reviewer.

### Indexer / DB track

**Drill: Pool exhaustion simulation**

1. Start the local server and connect a Postgres instance.
2. Use `server/tests/load.js` to saturate the connection pool.
3. Diagnose the failure using `server/db/poolManager.ts` metrics output.
4. Restore service by identifying and closing the stale connections.
5. Document the root cause in a runbook entry in `docs/disaster-recovery.md`.

Pass criterion: service restored within 20 minutes without help from the primary mentor.

### Contract track

**Drill: Testnet contract upgrade with state migration**

1. Deploy the current `aegis_vault` contract to Stellar testnet via `scripts/deploy-local-contract.sh`.
2. Add a new persistent storage key to the contract (any field from ADR-015 or
   ADR-016 backlog works).
3. Migrate existing testnet state without losing any existing entries.
4. Run `scripts/export-contract-state.sh` before and after; verify the diff
   shows only the new key.
5. Update `src/generated/soroban-bindings.ts` via `scripts/generate-soroban-bindings.js`.

Pass criterion: migration complete, state verified, bindings updated — all within 8 hours, without primary mentor intervention after kick-off.

### ZK / Circuits track {#zk-track}

**Drill: Aegis Vault ZK rotation**

1. Modify `circuits/src/main.nr` to add a new public output (any non-breaking
   addition, e.g., a proof epoch field).
2. Compile the circuit with `nargo compile`.
3. Run the proving key generation via `@aztec/bb.js`.
4. Update `src/wasm/` artifacts and the SHA-256 in `src/wasm/telemetry_reader.wasm.sha256` (pattern).
5. Verify that all existing proofs in `test/zk-encoding.test.js` still pass
   against the new proving key.
6. Explain why the circuit change does not compromise soundness (written
   paragraph in the PR description).

Pass criterion: all tests pass, soundness argument is coherent — within 16 hours, mentor available for questions but not providing the answers.

**Note:** This drill requires running `nargo` and `bb.js` locally. The
toolchain setup is in `docs/zk-design.md`. If the toolchain setup takes
more than 2 hours, that is a bug in the documentation — file a first-spike task.

### PWA / Offline track

**Drill: CRDT partition-heal**

1. Set up two simulated browser tabs using `test/crdt-sync.test.js`'s partition
   simulation helpers.
2. Apply conflicting mutations to `src/lib/crdt.ts` state in both partitions.
3. Reconnect the partitions and verify that the state converges to the
   expected merged value.
4. Identify any mutation that fails to converge (introduce one deliberately)
   and explain why.

Pass criterion: convergence verified, failure case explained — within 4 hours.

### Maps / WebGPU track

**Drill: GPU-tier fallback regression**

1. Set `VITE_FORCE_CANVAS_FALLBACK=1` in `.env`.
2. Run `test/spatial-cluster.test.js` — all tests must pass in fallback mode.
3. Introduce a shader change in `src/shaders/clusterShader.wgsl` that would
   fail on a GPU but degrade gracefully in fallback mode.
4. Write a test that verifies the graceful degradation path.

Pass criterion: fallback tests pass, new test merged — within 8 hours.

---

## 6. DAO funding proposal

### Preamble

HelPhone's four bus-factor-1 subsystems (Soroban contracts, Indexer/DB, ZK
circuits, Maps/WebGPU) each carry a risk of complete operational failure on
a single departure or illness. The following budget is proposed to fund the
first-spike program for four quarters (2027), after which the program should
be self-sustaining via the mentor-rotation model.

### Proposed budget (FY 2027)

All amounts are in XLM, drawn from the `teaching_bps` slice of the
sustainability reserve (ADR-015). `teaching_bps` default = 20% of `fee_bps`.

| Line item | Participants | Hours each | Rate (XLM/h) | Total (XLM) |
|---|---|---|---|---|
| General track spikes (×8) | 8 | 8 h | 50 | 3,200 |
| Indexer/DB track spikes (×4) | 4 | 16 h | 75 | 4,800 |
| Contract track spikes (×4) | 4 | 24 h | 100 | 9,600 |
| ZK fellowship (×2) | 2 | 40 h | 150 | 12,000 |
| PWA/Offline spikes (×4) | 4 | 16 h | 75 | 4,800 |
| Maps/WebGPU spikes (×4) | 4 | 16 h | 75 | 4,800 |
| Mentor stipends (4 mentors × 4 quarters × 6 h) | 4 | 24 h | 100 | 9,600 |
| External ZK audit (bridge until ZK fellow qualified) | — | 20 h | 200 | 4,000 |
| **Total** | | | | **52,800 XLM** |

### Milestone gates

Funding is released in quarterly tranches, not upfront. Each tranche requires:

- **Q1 2027:** ≥2 General track spikes completed and demoed. Bus-factor ledger
  updated. ZK fellowship applications open.
- **Q2 2027:** ≥1 Contract track graduation drill completed. ≥1 Indexer/DB
  graduation drill completed. Conversion metric ≥40%.
- **Q3 2027:** ZK fellow completes graduation drill. ≥1 Maps/WebGPU graduation
  drill completed. Conversion metric ≥50%.
- **Q4 2027:** All bus-factor-1 subsystems have a drilled backup. Program
  self-sustaining or sunset clause invoked.

### Sunset clause

If the conversion metric falls below 30% for two consecutive quarters, the
program funding is suspended and a DAO vote is required to re-open. The
threshold exists to prevent the program from becoming a credential farm with
no operational depth.

### Governance

This proposal is submitted as a `TeachingFundProposal` variant to
`contracts/helphone_dao/src/lib.rs` (pending ADR-015 implementation). Quorum
and approval threshold follow the DAO's standard vote rules. The proposal is
proposed by `@helphone-maintainers` and must be seconded by at least one
independent contributor.

---

## Appendix: Conversion metric dashboard

| Quarter | Spikes completed | Graduates with 2nd spike | Conversion rate | Status |
|---|---|---|---|---|
| 2027-Q1 | — | — | — | Not started |
| 2027-Q2 | — | — | — | Not started |
| 2027-Q3 | — | — | — | Not started |
| 2027-Q4 | — | — | — | Not started |

*Updated quarterly by `@helphone-maintainers` after the last monthly demo of each quarter.*
