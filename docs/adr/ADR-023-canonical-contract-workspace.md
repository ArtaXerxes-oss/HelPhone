# ADR-023 — Canonical Soroban Contract Workspace

**Date:** 2026-11-19
**Status:** Proposed
**ISP / Spike:** #980
**Decision owner:** @helphone-contract-owner
**Review required:** @helphone-maintainers (see `.github/CODEOWNERS`)

---

## Context

#980 identified two Soroban trees: `contracts/` (aegis_vault, emergency_vault,
helphone_dao, maintainer_vault) and the legacy standalone `contract/` workspace
(`helphone-contract`). The legacy crate duplicates request/responder storage
keys (`req`, `resp`, `rcount`, `active`) and ships its own build profile, so
tooling and deployment scripts disagree about which tree is canonical.

---

## Options considered

### Option A — Keep both trees as independent deployment targets

**Pros:**
- No migration work.

**Cons:**
- Duplicate storage layouts and two SDK/profile baselines.
- Bindings, SBOM, and deployment scripts must choose a tree per consumer.

**Cost / effort:** none now; permanent ambiguity.

### Option B — `contracts/` is canonical; `contract/` is frozen legacy (chosen)

**Description:** Add every deployed crate to the root workspace. Generated
bindings already enumerate `contracts/*`; `.env.example` now names the full
canonical set. The legacy crate remains excluded for the existing integration
fixture but is not a deployment target.

**Evidence / benchmark:** `scripts/generate-soroban-bindings.js` reads
`contracts/`; root `Cargo.toml` omitted `emergency_vault`; both trees pin
different Soroban SDK majors.

**Pros:**
- One workspace, one release profile, one binding manifest.
- No duplicate deployed storage layouts.

**Cons:**
- Legacy integration test keeps its own workspace until migrated.

**Cost / effort:** small; documentation and manifest alignment only.

---

## Decision

**Chosen:** Option B.

**Rationale:** `contracts/` already contains every deployed subsystem and is
the only tree read by binding generation. Freezing the legacy tree removes
duplicate deployed storage layouts without breaking the existing local
integration harness.

---

## Consequences

### Subsystems affected

| Subsystem | Impact | Follow-up action | Owner | Due |
|---|---|---|---|---|
| Contracts | Root workspace now builds all four deployed crates | CI confirms workspace build | @helphone-contract-owner | next release |
| Tooling | Bindings/SBOM use canonical set | Legacy fixture migration follow-up | @helphone-contract-owner | 2027-Q1 |
| Config | `.env.example` documents canonical IDs | Deployments set the new IDs | @helphone-maintainers | next deploy |

### Risks

- The legacy integration fixture still references `contract/` and must be
  migrated before that tree can be deleted.

### Follow-up ADRs

- ADR-NNN: retire `contract/helphone-contract` after integration fixture migration.

---

## Done-definition checklist

- [x] Status set
- [x] Context names the forcing function
- [x] ≥2 options considered with trade-offs
- [x] Decision cites evidence
- [x] Consequences table filled
- [x] Added to `docs/adr/README.md` index
- [ ] CODEOWNERS review obtained
