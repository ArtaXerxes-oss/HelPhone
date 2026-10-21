# ADR-022 — Honest Dispatch ETA: Ranges, Fatigue Pace, and Degraded-State Signalling

**Date:** 2026-10-17
**Status:** Proposed
**ISP / Spike:** ISP-105 / #775
**Decision owner:** @helphone-maintainers
**Review required:** @helphone-maintainers (see `.github/CODEOWNERS`)

---

## Context

The requester-facing ETA is computed from `src/lib/routing.ts` and `src/workers/routingWorker.js`. When Mapbox is unreachable or rate-limited, the ETA silently falls back to a distance-over-constant-speed number that looks identical to a traffic-aware one. Dispatch also ignores responder fatigue (consecutive completed runs), so a nearby tired responder is preferred over a slightly farther fresh one. A confidently wrong ETA is a safety issue (see #775, section 9).

This ADR records the in-repo part of the response: a pure estimator that makes degradation visible and folds fatigue into ranking. It is a prototype of the decision, not the full spike.

---

## Options considered

### Option A — Keep a single-number ETA, tune the fallback speed constant

**Pros:**
- No UI change.

**Cons:**
- Keeps false precision; fallback still looks like a measurement.

### Option B — Range plus explicit degraded flag (chosen)

**Description:** `src/lib/etaEstimate.ts` returns `{ minMinutes, maxMinutes, confidence, degraded, label }`. Fallback estimates span a fast/slow speed band, scale by a fatigue pace multiplier and an optional closure penalty, and are labelled "estimate, offline". `rankByRealisticEta` orders candidates by range midpoint instead of raw distance.

**Pros:**
- Fallback output can no longer be rendered identically to traffic-aware output.
- Fatigue and closures enter dispatch ordering through one small, testable function.

**Cons:**
- Wider ranges may feel less reassuring to requesters (trust impact not studied).
- Constants are assumptions (see below).

### Option C — Full predictive stack (traffic cache, versioned worker snapshots, realized-ETA telemetry)

**Pros:**
- Addresses staleness and measurement end to end.

**Cons:**
- Needs historical GPS trails, quota data and user research that are not available in this repository.

---

## Decision

**Chosen:** Option B as the first increment, with Option C remaining open.

**Rationale:** It removes the pixel-identical silent fallback and the fatigue blind spot without new dependencies, and can be gated by the existing `predictiveEtaV2` flag when wired in.

**Unvalidated parameters** (in `src/lib/etaEstimate.ts`): fatigue starts at 5 consecutive runs, adds 10% per run, capped at 1.5x; traffic-aware uncertainty is +/-15%; fallback speed band is 15-40 km/h. None were fitted to HelPhone data. They are placeholders for the experiments in #775.

---

## Consequences

### Subsystems affected

| Subsystem | Impact | Follow-up action | Owner | Due |
|---|---|---|---|---|
| `src/lib/etaEstimate.ts` | New pure module, not yet called | Wire into `routing.ts` / `routingWorker.js` behind `predictiveEtaV2` | @helphone-maintainers | TBD |
| `src/pages/Help.jsx` | Not changed | Render `degraded` ETAs with distinct style and visible notice | @helphone-maintainers | TBD |
| `src/lib/telemetry.ts` | Not changed | Record `eta_realized` and displayed range | @helphone-maintainers | TBD |

### Risks

- Fatigue weights are a fairness judgement as well as a numeric one; unfitted values could reorder who gets called.
- Not addressed here: Mapbox quota caching and pruning, reconnect convergence, worker snapshot versioning, closure overlay integration, dashboards, load tests.
- No displayed-vs-realized error, quota, or trust measurements exist for this change.

### Follow-up ADRs

- ADR on Matrix-call caching and quota policy.

---

## Done-definition checklist

- [x] Status set
- [x] Context names the forcing function
- [x] ≥2 options considered with trade-offs
- [ ] Decision cites evidence (no measurements yet; parameters are assumptions)
- [x] Consequences table filled
- [x] Added to `docs/adr/README.md` index
- [ ] CODEOWNERS review obtained
