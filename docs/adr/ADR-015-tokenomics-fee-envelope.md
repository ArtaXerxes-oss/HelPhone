# ADR-015 — Tokenomics: Fee Envelope, Sustainability Reserve & Maintainer Grant Model

**Date:** 2026-10-16
**Status:** Proposed
**ISP / Spike:** ISP-141
**Decision owner:** @helphone-contract-owner
**Review required:** @helphone-maintainers, @helphone-contract-owner

---

## Context

HelPhone's Soroban contracts (`contracts/helphone_dao/src/sustainability.rs`,
`contracts/aegis_vault/src/treasury.rs`) implement a fee-on-transaction model
that funds the sustainability reserve and pays registered maintainers. As the
platform scales from testnet toward production and toward multi-tenant
deployments (ISP-143), three tensions crystallise:

1. **Fee level vs adoption.** A fee that is too high deters emergency responders
   from registering; too low starves the reserve that pays for exotic-skill
   mentorship (ISP-148, `contracts/helphone_dao/src/sustainability.rs` line ~80).
2. **Reserve liquidity vs grant cadence.** The reserve must survive a 90-day
   famine (no new requests) while still disbursing monthly maintainer grants.
   The current `fee_bps` value is hardcoded; there is no on-chain governance
   path to adjust it without a contract upgrade.
3. **Mentorship allocation.** ISP-148 requires that a share of the reserve be
   earmarked for teaching time (ZK, Soroban, CRDT tracks). The current contract
   has no `teaching_bps` field; all surplus goes to `total_disbursed` for
   shipped code, not for knowledge transfer.

The forcing function is the first-spike program (ISP-148): the DAO vote on
mentor funding cannot proceed until the on-chain envelope for teaching is
specified and audited.

---

## Options considered

### Option A — Static `fee_bps` + off-chain governance

Keep `fee_bps` hardcoded at the current value. DAO votes on fee changes via
off-chain proposal; a new contract version is deployed if the vote passes.

**Evidence:** Current `sustainability.rs` implements this model.
`MaintainerFunding.jsx` reads `fee_bps` and `total_disbursed` from the contract.

**Pros:**
- Simplest implementation; no additional contract storage.
- No on-chain governance attack surface (vote manipulation, quorum gaming).

**Cons:**
- Every fee change requires a contract upgrade with full re-deploy and
  migration, a multi-day operation under disaster conditions.
- Mentorship allocation requires a separate contract field that is impossible
  to add without a breaking schema change under this option.
- Bus-factor 1 on fee governance: whoever can deploy the contract controls the
  fee.

**Cost / effort:** Zero new code. Defers governance risk.

---

### Option B — Governance-adjustable `fee_bps` + `teaching_bps` field

Add a DAO-vote-gated `set_fee` instruction that updates `fee_bps` within a
hard-coded floor/ceiling (e.g., 10–500 bps). Add `teaching_bps` as a separate
reserve slice. Both values live in Soroban persistent storage. A 2-of-N
multisig from `config/maintainer-keys.json` is required to execute the update
after a passing DAO vote.

**Evidence:** `contracts/helphone_dao/src/lib.rs` already has a `vote` entry
point and a `Proposal` type. Extending it with `FeeUpdate` and `TeachingSlice`
variants follows the same pattern. Storage cost delta: ~128 bytes per new field
(two `u32`s), well within the current footprint budget (see ADR-001).

**Pros:**
- Separates teaching budget from shipping budget; enables the ISP-148 mentor
  funding DAO proposal.
- Adjustable without re-deploy within the governance-approved range.
- Multisig requirement keeps bus-factor ≥2 on every fee change.

**Cons:**
- Additional contract complexity and test surface.
- Governance quorum calculation is not yet specified (follow-up ADR needed).
- Front-end `MaintainerFunding.jsx` must be updated to display both `fee_bps`
  and `teaching_bps`.

**Cost / effort:** ~2 days Rust + 0.5 days TypeScript binding regeneration.

---

### Option C — Oracle-fed dynamic fee (algorithmic adjustment)

An off-chain oracle (running in `server/indexer/daemon.ts`) monitors the reserve
balance and posts a fee recommendation; the DAO vote ratifies it quarterly.

**Pros:** Self-stabilising reserve under variable demand.

**Cons:** Oracle centralisation reintroduces a single point of failure.
Complexity far exceeds the current threat level. Deferred to a later ADR when
multi-vendor cost control (ISP-147) is resolved.

---

## Decision

**Chosen:** Option B — Governance-adjustable fee with `teaching_bps`.

**Rationale:** The ISP-148 first-spike program is a hard dependency: the DAO
cannot vote on mentor funding without an on-chain teaching reserve. Option A
cannot support this without a breaking contract upgrade. Option C introduces
oracle risk that is not warranted at current scale. Option B's storage cost is
negligible (ADR-001 established packed storage) and the governance pattern is
already partially implemented in `helphone_dao/src/lib.rs`.

**Constraint:** `fee_bps` floor = 10, ceiling = 500 (basis points). `teaching_bps`
is a slice of the collected fee (not additive), defaulting to 20% of `fee_bps`.
Total reserve disbursement = `(fee_bps - teaching_bps) / fee_bps * collected`.

---

## Consequences

### Subsystems affected

| Subsystem | Impact | Follow-up action | Owner | Due |
|---|---|---|---|---|
| `contracts/helphone_dao` | Add `FeeUpdate` proposal variant + `teaching_bps` field | Rust implementation | @helphone-contract-owner | 2026-Q4 |
| `src/generated/soroban-bindings.ts` | Regenerate after contract change | Run `scripts/generate-soroban-bindings.js` | @helphone-contract-owner | 2026-Q4 |
| `src/components/MaintainerFunding.jsx` | Display `teaching_bps` and teaching reserve balance | UI update | @helphone-maps-owner | 2026-Q4 |
| `docs/first-spike-program.md` | Reference `teaching_bps` as the on-chain funding mechanism | Doc update | @helphone-maintainers | 2026-Q4 |
| DAO vote proposal | Draft and publish mentor funding proposal | DAO governance | @helphone-maintainers | 2026-Q4 |

### Risks

- Governance quorum rules are undefined; a separate ADR is required before the
  first on-chain fee vote can be valid.
- Front-running risk on fee announcements: mitigated by the multisig
  requirement and the 48-hour announcement window before execution.

### Follow-up ADRs

- ADR-021: Multi-vendor cost control (spending envelope interacts with reserve balance).

---

## Done-definition checklist

- [x] Status set
- [x] Context names the forcing function
- [x] ≥2 options considered with trade-offs
- [x] Decision cites evidence
- [x] Consequences table filled
- [x] Added to `docs/adr/README.md` index
- [ ] CODEOWNERS review obtained
