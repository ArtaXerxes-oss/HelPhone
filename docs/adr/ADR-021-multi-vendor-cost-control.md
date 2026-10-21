# ADR-021 — Multi-Vendor Cost Control: Spending Envelopes & Kill-Switch Protocol

**Date:** 2026-10-16
**Status:** Proposed
**ISP / Spike:** ISP-147
**Decision owner:** @helphone-maintainers
**Review required:** @helphone-maintainers, @helphone-contract-owner, @helphone-security-owner

---

## Context

HelPhone's operational costs span three vendor categories:

1. **Stellar network:** XLM for transaction fees and Soroban storage rent.
   `src/lib/footprint.ts` calculates rent; `scripts/renew-rent.sh` automates
   renewal. `contracts/aegis_vault/src/treasury.rs` holds the XLM operational
   reserve.
2. **Infrastructure:** Render.com web service and cron jobs (`render.yaml`),
   Postgres database, Redis (for `server/lib/redisPubSub.js`).
3. **Third-party APIs:** Mapbox (map tiles, `VITE_MAPBOX_TOKEN`), ZK proving
   infrastructure (`VITE_ZK_PROVER_URL`), and future attester APIs (ADR-016).

Currently there are no spending envelopes, no automated alerts when costs spike,
and no kill-switch protocol that a maintainer can execute at 3 AM when a
runaway process drains the Stellar treasury or hits a Mapbox quota cap during
a disaster surge. The `render.yaml` cron for state export runs daily regardless
of treasury balance.

The forcing function is ISP-147: the DAO cannot approve the budget proposal in
ISP-148 (mentor funding via `contracts/helphone_dao/src/sustainability.rs`)
without knowing that operational costs are bounded and that the treasury cannot
be drained by a runaway service.

---

## Options considered

### Option A — Manual monitoring + runbook (current state + documentation)

Document the cost structure in a runbook. Operators check vendor dashboards
manually. No automated enforcement.

**Pros:**
- Zero engineering cost.

**Cons:**
- A runaway `rentRenewer.ts` process during a disaster surge could drain the
  Stellar treasury in hours. No automated detection.
- Manual monitoring fails exactly when it is most needed: maintainers are
  asleep or busy responding to the disaster.
- DAO has no visibility into operational spend vs treasury balance.

---

### Option B — Spending envelopes with automated kill-switch

Define per-vendor spending envelopes as configuration in `public/config.json`
(feature-flag pattern already in `src/lib/featureFlags.ts`). Implement three
layers:

**Layer 1 — Stellar treasury floor:** `src/lib/rpcHealth.ts` is extended to
check the treasury balance via RPC. If balance falls below a configured floor
(e.g., 50 XLM), `server/indexer/rentRenewer.ts` is suspended and an alert is
emitted via `server/lib/alertWebhook.ts`. The floor is a contract-level
constant in `contracts/aegis_vault/src/treasury.rs`.

**Layer 2 — Infrastructure spend guard:** Render.com and other vendors support
webhook alerts on billing thresholds. These webhooks POST to a new
`server/routes/costAlert.ts` endpoint that fires the kill-switch on the
affected service (marks the feature flag `cost_kill_mapbox: true` in
`public/config.json`).

**Layer 3 — ZK prover rate limit:** `src/services/zkProver.ts` already has
circuit-breaker logic. Extend it with a daily proof count ceiling (configurable
in `public/config.json`). When the ceiling is hit, the prover falls back to a
degraded mode (coarser privacy zone, reduced proof complexity) rather than
refusing service entirely.

**Evidence:** `server/lib/alertWebhook.ts` exists but is 24 bytes (stub). The
pattern is established; the implementation is missing. `src/lib/featureFlags.ts`
already handles kill-switch flags. `src/lib/rpcHealth.ts` already polls
Stellar RPC.

**Pros:**
- Automated protection during off-hours.
- DAO-visible: treasury floor and current balance can be displayed in
  `src/components/TreasuryPanel.jsx`.
- Graceful degradation (ZK coarse fallback) instead of hard failure during
  cost spikes.

**Cons:**
- Layer 2 depends on vendor webhook support; Render.com webhook configuration
  requires manual setup.
- Kill-switch on Mapbox degrades the map UX for all users, not just the cost
  trigger. Must be paired with a user-facing indicator in `src/components/OfflineIndicator.jsx`.

**Cost / effort:** ~2.5 days implementation.

---

### Option C — Per-request cost accounting in Soroban

Each Soroban transaction records its fee; the `helphone_dao` contract enforces
a per-block fee cap. Requests beyond the cap are rejected at the contract level.

**Pros:**
- Enforcement is on-chain and DAO-governed.

**Cons:**
- Soroban fee caps are already enforced by the network; adding a per-block
  application-level cap creates redundancy.
- Does not address infrastructure (Render, Mapbox) costs at all.
- Contract upgrade required to change the cap.

---

## Decision

**Chosen:** Option B — Multi-layer spending envelopes with automated kill-switch.

**Implementation priority:**
1. Layer 1 (Stellar treasury floor) — implements in ISP-147; aligns with ADR-015
   `teaching_bps` reserve accounting.
2. Layer 3 (ZK prover rate limit) — implements in ISP-147; low risk, high value.
3. Layer 2 (infrastructure webhooks) — scheduled for 2026-Q4; depends on
   vendor webhook configuration which requires manual ops work.

**Kill-switch governance:** Any kill-switch invocation that affects P0
(life-critical) dispatch (per ADR-020) requires a 2-of-N multisig from
`config/maintainer-keys.json`, not an automated trigger. Automated triggers
are allowed only for P2 and P3 services (telemetry, Mapbox tile loading,
non-emergency APIs).

---

## Consequences

### Subsystems affected

| Subsystem | Impact | Follow-up action | Owner | Due |
|---|---|---|---|---|
| `src/lib/rpcHealth.ts` | Add treasury floor check | Implementation | @helphone-contract-owner | 2026-Q4 |
| `server/indexer/rentRenewer.ts` | Suspend on floor breach | Implementation | @helphone-db-owner | 2026-Q4 |
| `server/lib/alertWebhook.ts` | Implement alert dispatch | Implementation | @helphone-dispatch-owner | 2026-Q4 |
| `src/services/zkProver.ts` | Daily proof count ceiling | Implementation | @helphone-zk-owner | 2026-Q4 |
| `src/components/TreasuryPanel.jsx` | Display treasury floor and current balance | UI | @helphone-maps-owner | 2026-Q4 |
| `public/config.json` | Add `cost_envelopes` section | Config | @helphone-maintainers | 2026-Q4 |
| `contracts/aegis_vault/src/treasury.rs` | Add `TREASURY_FLOOR_XLM` constant | Rust | @helphone-contract-owner | 2026-Q4 |
| `docs/disaster-recovery.md` | Add cost-spike runbook section | Documentation | @helphone-maintainers | 2026-Q4 |

### Risks

- **Kill-switch latency:** Layer 2 vendor webhooks have documented latency of
  up to 5 minutes. The treasury floor (Layer 1) provides the fast-path
  protection for Stellar costs.
- **False positive kills:** A cost spike during a genuine disaster surge could
  trigger a kill-switch at the worst possible time. P0-path services are exempt
  from automated kill-switch by policy.

### Follow-up ADRs

- ADR-015: `teaching_bps` reserve accounting must be included in the treasury
  floor calculation.
- ADR-020: P0 dispatch path is exempt from automated cost kill-switches.

---

## Done-definition checklist

- [x] Status set
- [x] Context names the forcing function
- [x] ≥2 options considered with trade-offs
- [x] Decision cites evidence
- [x] Consequences table filled
- [x] Added to `docs/adr/README.md` index
- [ ] CODEOWNERS review obtained
