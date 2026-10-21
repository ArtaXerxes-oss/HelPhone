# TODO

<!-- FIRST-SPIKE BACKLOG — see docs/first-spike-program.md for the full program.
     Labels used in this file:
       difficulty: beginner | intermediate | advanced
       mentor: @handle (the named mentor for this task; see bus-factor ledger)
       demo-slot: YYYY-QN (the monthly demo slot to present this if completed)
       subsystem: ui | api | contracts | db | zk | pwa | maps | dispatch | telemetry | security
       ladder: 1 | 2 | 3 (corresponds to onboarding ladder stage)
     Tasks marked [first-spike] are curated safe first tasks.
     Tasks marked [x] are done. Tasks marked [ ] are open.
-->

## First-spike backlog (safe first tasks — start here)

These tasks are explicitly safe for newcomers. Each one is scoped to a single
subsystem, has a named mentor, and does not touch life-critical paths.
See `docs/onboarding-ladder.md` for the curriculum.

### Ladder Stage 1 — UI (beginner, ~2–4h)

- [ ] Add missing `aria-label` to the request type selector in `src/pages/Help.tsx`
  <!-- first-spike | difficulty: beginner | mentor: @helphone-ui-owner | demo-slot: 2027-Q1 | subsystem: ui | ladder: 1 -->
  Test coverage: `tests/e2e/a11y.spec.ts` — find the failing assertion and make it pass.

- [ ] Fix horizontal overflow on iPhone SE (375px) in `src/pages/Ranking.tsx`
  <!-- first-spike | difficulty: beginner | mentor: @helphone-ui-owner | demo-slot: 2027-Q1 | subsystem: ui | ladder: 1 -->
  Run `npx playwright test --project=layout-iphone-se` to reproduce. Fix the CSS.

- [ ] Add a missing `key` prop warning fix in `src/App.tsx` list renders
  <!-- first-spike | difficulty: beginner | mentor: @helphone-ui-owner | demo-slot: 2027-Q1 | subsystem: ui | ladder: 1 -->
  Run `npm run dev` and check the React DevTools console for key warnings.

- [ ] Add a `data-testid` to the ZK privacy checkpoint panel for E2E test targeting
  <!-- first-spike | difficulty: beginner | mentor: @helphone-ui-owner | demo-slot: 2027-Q1 | subsystem: ui | ladder: 1 -->

- [ ] Add a loading state for on-chain verification refresh in `src/pages/Help.tsx`
  <!-- first-spike | difficulty: beginner | mentor: @helphone-ui-owner | demo-slot: 2027-Q1 | subsystem: ui | ladder: 1 -->
  Partially covered by the checkpoint `recording` state — extend it to show a spinner.

- [ ] Add snapshot test coverage for `src/components/Breadcrumb.jsx`
  <!-- first-spike | difficulty: beginner | mentor: @helphone-ui-owner | demo-slot: 2027-Q1 | subsystem: ui | ladder: 1 -->
  Use `test/snapshots.test.jsx` as the pattern.

### Ladder Stage 2 — API (intermediate, ~4–8h)

- [ ] Add `/api/version` endpoint returning server version and Stellar network
  <!-- first-spike | difficulty: intermediate | mentor: @helphone-dispatch-owner | demo-slot: 2027-Q1 | subsystem: api | ladder: 2 -->
  Add to `server/routes/health.ts`, document in `swagger.json`, test in `test/server-api.test.js`.

- [ ] Label all routes in `server/routes/docs.ts` with their ADR-020 priority tier
  <!-- first-spike | difficulty: intermediate | mentor: @helphone-dispatch-owner | demo-slot: 2027-Q1 | subsystem: api | ladder: 2 -->
  Use the P0/P1/P2/P3 vocabulary from ADR-020. Add JSDoc comments to each route handler.

- [ ] Add request-ID header (`X-Request-Id`) to all server responses for tracing
  <!-- first-spike | difficulty: intermediate | mentor: @helphone-dispatch-owner | demo-slot: 2027-Q1 | subsystem: api | ladder: 2 -->
  Add to `server/middleware/logger.ts`. Test in `test/server-api.test.js`.

- [ ] Add input validation for the `type` field on request creation
  <!-- first-spike | difficulty: intermediate | mentor: @helphone-dispatch-owner | demo-slot: 2027-Q1 | subsystem: api | ladder: 2 -->
  Allowed values: medical, danger, lost, fallen. Reject unknown types with 400.

- [ ] Add a user-facing history view for `Stellar Expert` records
  <!-- first-spike | difficulty: intermediate | mentor: @helphone-ui-owner | demo-slot: 2027-Q1 | subsystem: api | ladder: 2 -->
  Read from `server/routes/history.ts`. Display in a component on `src/pages/VaultDashboard.jsx`.

### Ladder Stage 3 — Contracts / DB (advanced, ~8–16h)

- [ ] Add unit test for `record_expert_verification` read/write path in `contracts/aegis_vault/src/test.rs`
  <!-- first-spike | difficulty: advanced | mentor: @helphone-contract-owner | demo-slot: 2027-Q2 | subsystem: contracts | ladder: 3 -->
  Follow patterns in `contracts/aegis_vault/src/test.rs`. Run `cargo test --locked` in `contracts/aegis_vault/`.

- [ ] Implement `withTenant` wrapper in `server/db/connection.ts` (ADR-017 prerequisite)
  <!-- first-spike | difficulty: advanced | mentor: @helphone-db-owner | demo-slot: 2027-Q2 | subsystem: db | ladder: 3 -->
  See ADR-017 for spec. Add test in `test/db-pool.test.js`.

- [ ] Write the pool exhaustion runbook in `docs/disaster-recovery.md`
  <!-- first-spike | difficulty: advanced | mentor: @helphone-db-owner | demo-slot: 2027-Q1 | subsystem: db | ladder: 3 -->
  Diagnose via `server/db/poolManager.ts` metrics. Document the 3 AM recovery steps.

- [ ] Implement treasury floor check in `src/lib/rpcHealth.ts` (ADR-021 Layer 1)
  <!-- first-spike | difficulty: advanced | mentor: @helphone-contract-owner | demo-slot: 2027-Q2 | subsystem: contracts | ladder: 3 -->
  Check XLM balance via Stellar RPC. Emit alert via `server/lib/alertWebhook.ts` when below floor.

- [ ] Add binary schema upgrade procedure to `docs/telemetry-architecture.md`
  <!-- first-spike | difficulty: advanced | mentor: @helphone-telemetry-owner | demo-slot: 2027-Q1 | subsystem: telemetry | ladder: 3 -->
  Document FlatBuffers schema evolution, WASM regeneration, and SHA-256 update procedure.

---

## Production readiness

- [ ] Deploy `aegis_vault` to testnet/mainnet and set `VITE_AEGIS_VAULT_ID`
- [ ] Decide whether `helphone-contract` should be deployed separately or bundled per environment
- [ ] Add a real indexer for Soroban events if long-term audit/search is needed
- [ ] Replace the localStorage fallback once on-chain reads are fully stable

## Architecture (ADR follow-up actions)

- [ ] Implement `teaching_bps` field in `contracts/helphone_dao/src/sustainability.rs` (ADR-015)
- [ ] Complete `circuits/responder_credential/` Noir circuit (ADR-016)
- [ ] Composite partition key `(tenant_id, ledger_seq)` in `server/db/partitioning.js` (ADR-017)
- [ ] Federation peer seed list storage key in `contracts/helphone_dao` (ADR-018)
- [ ] `JurisdictionGate` halt mode in `server/db/connection.ts` (ADR-019, pending legal review)
- [ ] Priority queue tiers in `server/routes/dispatch.ts` (ADR-020)
- [ ] ZK prover daily proof count ceiling in `src/services/zkProver.ts` (ADR-021)

## UX follow-up

- [x] Add keyboard navigation for the Mapbox search suggestions (↑/↓/Enter/Esc + ARIA combobox)
- [x] Close the search suggestion dropdown on blur/click outside (pointerdown outside)
- [x] Show a direct link to the transaction hash (ZK checkpoint + offer receipt → Stellar Expert testnet)

## Bus-factor / onboarding (ISP-148)

- [ ] Recruit contract-track backup (CRITICAL: bus-factor 1 on Soroban contracts)
      <!-- target: 2027-Q1 | owner: @helphone-maintainers -->
- [ ] Recruit DB-track backup (CRITICAL: bus-factor 1 on indexer/DB)
      <!-- target: 2027-Q1 | owner: @helphone-maintainers -->
- [ ] Initiate ZK fellowship track (HIGH RISK: bus-factor 1 on ZK circuits)
      <!-- target: 2026-Q4 | owner: @helphone-maintainers -->
- [ ] Recruit maps-track backup (HIGH RISK: bus-factor 1 on WebGPU/maps)
      <!-- target: 2027-Q1 | owner: @helphone-maps-owner -->
- [ ] Execute quarterly bus-factor ledger refresh (2027-Q1)
      <!-- recurring | owner: @helphone-maintainers -->
- [ ] Draft DAO vote proposal for mentor funding (ADR-015 teaching_bps)
      <!-- target: 2026-Q4 | owner: @helphone-maintainers -->
