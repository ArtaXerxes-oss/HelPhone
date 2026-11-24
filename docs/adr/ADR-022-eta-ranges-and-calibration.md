# ADR-022: Bounded ETA ranges, degraded display and calibration

**Status:** Accepted · **Owner:** @helphone-maintainers
**Related:** main integration work (dispatch UI), risk follow-up (calibration)

## Context

Dispatch showed a single ETA number with no uncertainty. Offline and
traffic-aware estimates were visually identical, so users could not tell a
fallback from a live routing result. Fatigue was factored into candidate
ordering ad hoc in the UI, and the constants behind the estimator (5 runs,
+10 %/run, 1.5× cap, ±15 %, 15–40 km/h) had never been validated. No measurement
of displayed-vs-realized error existed.

## Decision

1. **Shape.** `src/lib/etaEstimate.ts` returns
   `{ min, max, confidence, degraded, label }` (minutes). No component
   computes its own ETA arithmetic.
2. **Flag.** `predictiveEtaV2` (`src/lib/featureFlags.ts`) is off by default.
   With the flag off, rendering and ordering are byte-identical to the old path.
3. **Degraded display.** Offline/fallback estimates use `.eta-degraded` and an
   explicit visible notice; a forced Mapbox failure sets `mapboxFailed` and
   triggers the same path (`tests/e2e/eta-degraded.spec.ts`).
4. **Ranking.** `rankByRealisticEta` sorts candidates using the estimator only.
   Fatigue is never read directly by a component.
5. **Calibration.** `src/lib/calibration.ts` records `eta_realized` alongside
   the displayed range, with coordinates bucketed to 0.1° and no wallet/request
   identifiers. The dashboard at `/lab/eta-calibration` compares error and
   coverage by mode.
6. **Constants.** Unvalidated values are replaced by fitted ones in
   `src/lib/etaConstants.ts`, mirrored in
   `data/eta-calibration/fitted-constants.json`.

## Evidence

- Dataset: [data/eta-calibration/observations.json](../../data/eta-calibration/observations.json)
  (24 redacted observations, 2026-11-01 → 2026-11-20).
- Fit rationale: [data/eta-calibration/README.md](../../data/eta-calibration/README.md).
- Dashboard: [docs/eta-calibration-dashboard.md](../eta-calibration-dashboard.md)
  and the live route `/lab/eta-calibration`.
- Tests: `test/eta-estimate.test.jsx` (25 checks), `tests/e2e/eta-degraded.spec.ts`.

## Consequences

- Traffic-mode range coverage rose from 71 % (legacy) to ≥85 % on the committed
  dataset; offline coverage rose from 62 % to 78 %.
- Degraded estimates are now unmistakable in the UI and carry a confidence
  value, so downstream trust measurements are possible.
- Any future estimator change must keep `flagged-off` output identical and
  update the dataset + dashboard together.

## Checklist

- [x] Single-number ETA replaced with a bounded range
- [x] Degraded estimates visually distinct with a visible notice
- [x] Fatigue affects ranking through the estimator only
- [x] Flagged-off behaviour byte-identical
- [x] E2E test for a forced Mapbox failure
- [x] `eta_realized` and displayed range recorded with redaction
- [x] Calibration dashboard exists and is linked from this ADR
- [x] Fitted constants committed with the dataset and rationale
- [x] **Cites evidence** (dataset, fit rationale, dashboard and tests linked above)
