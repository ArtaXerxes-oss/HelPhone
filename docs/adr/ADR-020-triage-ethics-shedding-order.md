# ADR-020 — Triage Ethics & Load-Shedding Order Under Overload

**Date:** 2026-10-16
**Status:** Proposed
**ISP / Spike:** ISP-146
**Decision owner:** @helphone-maintainers
**Review required:** @helphone-maintainers, @helphone-dispatch-owner, @helphone-security-owner

> **Ethics and liability notice:** This ADR records an engineering decision
> about priority ordering. It does not constitute medical triage guidance.
> The shedding order must be reviewed by a qualified emergency-management
> professional before this ADR is accepted.

---

## Context

`server/routes/dispatch.ts` routes emergency requests to nearby responders.
ADR-003 identified load shedding as the highest-value follow-up for surge
conditions. Under extreme load (disaster surge, DDoS, infrastructure failure),
`dispatch.ts` must decide which messages to process, delay, or drop. Currently
there is no explicit priority ordering — messages are processed FIFO.

The ethical tension: any priority ordering is a statement about whose request
matters more. An incorrect priority ordering could cause a responder to be
dispatched to a lower-severity request while a life-threatening request waits.
Conversely, a system with no shedding order crashes entirely, serving nobody.

`docs/api-documentation.md` documents the route types; `server/routes/dispatch.ts`
handles `RqCreated`, `LocUpd`, `OfferMade`, `OfferAccepted`, and `StatusChange`
message types.

The forcing function is ISP-146: define the shedding order before multi-tenant
and federated deployments (ADR-017, ADR-018) create ambiguity about cross-node
shedding behaviour.

---

## Options considered

### Option A — FIFO (no shedding; current behaviour)

Process all messages in arrival order. Under overload, the queue grows until
the process OOMs or the WebSocket connection is dropped.

**Evidence:** `server/tests/load.js` shows the server saturates at ~2,000
concurrent WebSocket connections on a 512 MB Render instance.

**Pros:**
- No priority judgment required; neutral.
- Simplest implementation.

**Cons:**
- Under 5,000+ concurrent connections (plausible during a city-scale disaster),
  the server crashes and serves nobody. The worst possible outcome ethically.
- No feedback to clients; requests disappear silently.

---

### Option B — Explicit priority tiers with bounded queue per tier

Define four tiers based on message semantics, not user identity:

| Tier | Messages | Queue bound | Shedding behaviour |
|---|---|---|---|
| P0 — Life-critical | `RqCreated` (type=medical, danger) | Unbounded (shed P3 first) | Never dropped |
| P1 — Urgent | `RqCreated` (type=lost, fallen), `OfferAccepted` | 10,000 entries | Drop oldest if full |
| P2 — Operational | `OfferMade`, `StatusChange` | 5,000 entries | Drop oldest if full |
| P3 — Telemetry | `LocUpd` (ADR-003 §5: coalesce, lowest priority) | 1,000 entries | Drop oldest; coalesce |

Under sustained overload (P0 queue would exceed memory budget), `dispatch.ts`
emits a `503 Overloaded` signal and the client PWA falls back to polling mode
(`src/service-worker.js`).

**Evidence:** ADR-003 explicitly identified `LocUpd` coalescing as the
highest-value mitigation. P0/P1 distinction maps to the `type` field already
present on `RqCreated` messages in `server/routes/dispatch.ts`.

**Pros:**
- Life-critical requests are never shed while lower-priority traffic can be.
- Shedding is transparent (503 signal, not silent drop).
- PWA offline fallback (ADR-007, `src/service-worker.js`) provides client-side
  resilience during overload.
- Queue bounds are configurable via `public/config.json` feature flags.

**Cons:**
- Priority is based on the `type` field declared by the *requester*, not
  verified by a triage professional. A requester who declares `type=medical`
  to gain priority is not filtered. Mitigation: rate limiting per wallet
  (`server/middleware/rateLimiter.ts`) prevents systematic gaming.
- The distinction between P0 and P1 (medical vs lost) may be incorrect in
  specific scenarios (a lost child in sub-zero temperatures is life-critical).
  This is an unavoidable limitation of automated triage.

**Cost / effort:** ~1.5 days in `dispatch.ts` + `public/config.json` queue bounds.

---

### Option C — Responder-declared triage (offload priority decision to responders)

Responders ACK or NAK each request; their aggregate response rate determines
priority. High-response requests are escalated.

**Pros:**
- Human triage judgment in the loop.

**Cons:**
- Requires responders to be available before the priority decision is made —
  circular dependency during surge.
- Latency is too high for first dispatch.

---

## Decision

**Chosen:** Option B — Explicit priority tiers, **with the following ethical
constraints enforced at the engineering level:**

1. **Priority is based on message type, never on wallet identity or reputation
   score.** Adding a priority boost based on user identity would violate the
   neutrality principle and is prohibited in `dispatch.ts` code review checklist
   (see `docs/review-policy.md#dispatch`).
2. **P0 queue is never shed.** The only way to drop a life-critical request is
   via server OOM, which must be treated as a critical infrastructure failure,
   not a design choice.
3. **Shedding must be logged.** Every dropped message is written to
   `server/indexer/auditStreamer.js` with timestamp, tier, and reason.
   This log is non-deniable evidence of overload events.
4. **Queue bounds are reviewed quarterly** by the decision owner alongside the
   bus-factor ledger refresh.
5. **Emergency-management review gate:** This ADR cannot move to *Accepted*
   until the priority tier table has been reviewed and signed off by a qualified
   emergency-management professional.

---

## Consequences

### Subsystems affected

| Subsystem | Impact | Follow-up action | Owner | Due |
|---|---|---|---|---|
| `server/routes/dispatch.ts` | Implement priority queue tiers | Implementation | @helphone-dispatch-owner | 2026-Q4 |
| `server/indexer/auditStreamer.js` | Add shedding event log entries | Implementation | @helphone-db-owner | 2026-Q4 |
| `server/middleware/rateLimiter.ts` | Rate-limit per wallet to prevent gaming | Verification | @helphone-security-owner | 2026-Q4 |
| `public/config.json` | Add queue bound configuration | Config + feature flag | @helphone-maintainers | 2026-Q4 |
| `src/service-worker.js` | Verify 503 Overloaded triggers polling fallback | PWA test | @helphone-pwa-owner | 2026-Q4 |
| `docs/review-policy.md` | Add no-identity-priority rule to dispatch checklist | Doc update | @helphone-maintainers | 2026-Q4 |

### Risks

- **Miscategorisation:** The P0/P1 distinction is imperfect. Post-incident
  reviews should examine whether shedding decisions correlated with harm.
  This is a quarterly DAO-reported metric.
- **Legal exposure:** In some jurisdictions, a documented shedding order may
  create a duty-of-care argument. Legal review required per deployment.

### Follow-up ADRs

- ADR-018: Federation shedding — when a node is overloaded, does it shed
  locally or gossip the shed signal to peers?
- ADR-021: Multi-vendor cost control must not override P0 queue bounds.

---

## Done-definition checklist

- [x] Status set (Proposed; Emergency-management review required for Accepted)
- [x] Context names the forcing function
- [x] ≥2 options considered with trade-offs
- [x] Decision cites evidence
- [x] Consequences table filled
- [x] Added to `docs/adr/README.md` index
- [ ] CODEOWNERS review obtained
- [ ] Emergency-management professional sign-off (required for Accepted)
