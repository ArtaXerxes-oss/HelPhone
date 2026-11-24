# ADR-019 — Compulsion-Law Halt Doctrine: Jurisdiction-Triggered Data Isolation

**Date:** 2026-10-16
**Status:** Proposed
**ISP / Spike:** ISP-145
**Decision owner:** @helphone-maintainers
**Review required:** @helphone-maintainers, @helphone-security-owner, @helphone-db-owner

> **Legal disclaimer:** This ADR describes an engineering architecture. It is
> not legal advice. The compulsion-law analysis must be reviewed by qualified
> legal counsel in each jurisdiction before this ADR is accepted.

---

## Context

HelPhone processes emergency location data. In most jurisdictions, operators of
location-data services are subject to compelled-disclosure orders (subpoenas,
national security letters, emergency production orders). The architectural
question is: if the HelPhone server receives such an order, what is the
engineered response?

Three competing pressures:

1. **User privacy.** `src/lib/privacy.ts` coarsens location to ~1 km and
   `src/pages/Help.jsx` passes empty name/contact on-chain. The ZK proof in
   `circuits/src/main.nr` proves zone membership without revealing coordinates.
   The system is designed so that the server *cannot* comply with a location
   subpoena because it does not have precise location data.
2. **Operational continuity.** An operator who receives a compelled-disclosure
   order may be prohibited from telling users the order exists. A naive
   "shut down the service" response harms the users the order supposedly protects.
3. **Jurisdiction heterogeneity.** `docs/legal-compliance.md` notes multiple
   operating jurisdictions. The halt doctrine must be per-jurisdiction, not
   global, to avoid a single court in one country shutting down service
   worldwide.

The forcing function is ISP-145: define the halt doctrine before federated
deployments (ADR-018) create ambiguity about which node receives an order and
which nodes must respond.

---

## Options considered

### Option A — No engineered halt; respond to legal orders operationally

Trust the legal process. Operators consult counsel and respond to orders as
received. No special engineering. Document the data minimisation architecture
(`docs/privacy-policy.md`, `docs/security-architecture.md`) to demonstrate
that complying with a location subpoena is technically impossible.

**Pros:**
- Simplest; no additional code.
- Accurate: the server genuinely cannot produce precise location data.
- Legal: no risk of contempt by attempting to technically frustrate a lawful order.

**Cons:**
- Does not address orders for metadata (who submitted a request, when, from
  which IP). The server logs in `server/middleware/logger.ts` could expose
  this, even though precise location is protected.
- Does not address jurisdiction-specific take-down orders for the service itself.
- No runbook; operators face a novel legal situation without a prepared response.

---

### Option B — Per-jurisdiction data isolation with operator-triggered halt

`server/db/connection.ts` is extended with a `JurisdictionGate` that can set a
given tenant (per ADR-017) into read-only or full-halt mode. The gate is
triggered by the operator via a signed admin command (2-of-N multisig from
`config/maintainer-keys.json`). In halt mode:

- No new requests or offers are accepted.
- Existing in-progress requests are completed (grace period: 2 ledger closes).
- No new data is written to `server/db/`.
- The service returns HTTP 451 (Unavailable for Legal Reasons) with a
  jurisdiction-specific message.
- `src/service-worker.js` falls back to cached data so clients in the jurisdiction
  can still see their own previously submitted requests.

IP logging is disabled per-jurisdiction by `server/middleware/logger.ts`
configuration. Precise location is never stored (by design).

**Pros:**
- Operator has a prepared, legally-reviewed response path.
- Isolation is per-jurisdiction / per-tenant (ADR-017); other regions continue.
- HTTP 451 is the IETF-standardised signal for legal censorship, recognised by
  transparency-report tools.
- PWA offline cache allows users to continue seeing their data even during halt.

**Cons:**
- Engineered halt could be interpreted as obstruction in some jurisdictions
  (legal review required per deployment).
- 2-of-N multisig requirement means halt cannot be instant; ~minutes latency
  to assemble signatures. For urgent orders, an operator single-key emergency
  halt is required (lower security but faster).
- Adds `JurisdictionGate` complexity to `connection.ts`.

**Cost / effort:** ~2 days + legal review per deployment jurisdiction.

---

### Option C — Canary-warrant architecture (warrant canary in `public/config.json`)

Publish a daily-updated warrant canary in `public/config.json`. If the canary
is not updated within 48 hours, clients interpret this as a signal that a
compelled-disclosure order has been received. Clients can choose to stop
submitting data.

**Pros:**
- Well-understood legal mechanism.
- No server-side code changes required.
- Puts the disclosure decision in the hands of the client.

**Cons:**
- Effectiveness depends on jurisdiction; actively misleading a court by
  maintaining a canary under a gag order may itself be contempt in some
  jurisdictions.
- 48-hour window is too slow for emergency scenarios.
- `public/config.json` is already used for feature flags; conflating it with
  a legal canary creates maintenance complexity.

---

## Decision

**Chosen:** Option B (per-jurisdiction halt) as the primary mechanism,
**with Option A (data minimisation architecture) as the first line of defence.**

The data minimisation architecture is the primary protection: HelPhone cannot
comply with a location subpoena because it does not store precise locations.
This is documented in `docs/security-architecture.md` and `docs/privacy-policy.md`
and must be affirmatively demonstrated to legal counsel in each deployment
jurisdiction before launch.

Option B is the fallback when the order covers service operation, not just
data production. The `JurisdictionGate` is implemented per-tenant (ADR-017
tenant model), so a halt in jurisdiction X does not affect jurisdiction Y.

**Warrant canary (Option C):** Implement as an *additional* transparency
mechanism in `public/config.json`, separate from the halt trigger. Legal review
required per jurisdiction before canary is relied upon.

**Legal review gate:** This ADR cannot move to *Accepted* status until legal
counsel has reviewed the halt doctrine for each production deployment
jurisdiction and signed off. The decision owner must track this sign-off.

---

## Consequences

### Subsystems affected

| Subsystem | Impact | Follow-up action | Owner | Due |
|---|---|---|---|---|
| `server/db/connection.ts` | Add `JurisdictionGate` halt mode | Implementation | @helphone-db-owner | Legal review first |
| `server/middleware/logger.ts` | Per-jurisdiction IP logging disable | Configuration | @helphone-security-owner | 2026-Q4 |
| `src/service-worker.js` | Cache-first fallback during halt | PWA verification | @helphone-pwa-owner | 2026-Q4 |
| `docs/privacy-policy.md` | Document data minimisation as primary defence | Legal copy | @helphone-maintainers | Pre-launch |
| `public/config.json` | Add warrant canary field (after legal review) | Configuration | @helphone-maintainers | Per-jurisdiction |
| `docs/disaster-recovery.md` | Add halt-mode runbook section | Documentation | @helphone-db-owner | 2026-Q4 |

### Risks

- Legal review bottleneck: this ADR is Proposed until legal sign-off is received.
  Deployment is blocked on sign-off, not on engineering.
- Multisig halt latency: document the single-key emergency halt path and its
  security trade-offs in the runbook.

### Follow-up ADRs

- ADR-018: Federation topology must propagate halt signals to peer nodes.
- ADR-021: Multi-vendor cost control must not be used to bypass halt mode.

---

## Done-definition checklist

- [x] Status set (Proposed; Legal review required for Accepted)
- [x] Context names the forcing function
- [x] ≥2 options considered with trade-offs
- [x] Decision cites evidence
- [x] Consequences table filled
- [x] Added to `docs/adr/README.md` index
- [ ] CODEOWNERS review obtained
- [ ] Legal counsel sign-off (required for Accepted)
