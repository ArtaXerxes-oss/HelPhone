# ETA calibration dashboard

Route: `/lab/eta-calibration` · Component: `src/pages/CalibrationDashboard.tsx` · Evidence: [ADR-022](adr/ADR-022-eta-ranges-and-calibration.md)

The dashboard answers one question: **when we show a range, does the responder
actually arrive inside it?** It reads two sources:

1. the committed redacted dataset in `data/eta-calibration/observations.json`;
2. locally recorded outcomes from `src/lib/calibration.ts` (stored under
   `helphone:eta-calibration`, capped at 500 records).

## Sections

### Displayed vs. realized error

A table by mode (traffic / offline / fallback) with:

- **Mean |error|** — absolute difference between realized arrival and the
  midpoint of the displayed range;
- **Mean range width** — how wide the displayed range was;
- **Coverage** — share of observations whose realized arrival fell inside the
  displayed range.

Traffic rows use the teal surface; degraded rows use the coral surface, matching
the in-app ETA styling.

### Fitted vs. legacy constants

Every constant from `src/lib/etaConstants.ts` is shown next to the legacy value
and the committed fitted value, plus a check that the runtime copy matches the
dataset file. A mismatch means `etaConstants.ts` was edited without updating
`data/eta-calibration/fitted-constants.json`.

## Recording an outcome

```ts
import { recordEtaOutcome, appendCalibrationRecord } from "../lib/calibration";
import { toEtaEstimate } from "../lib/etaEstimate";

const displayed = toEtaEstimate(720, { degraded: true });
appendCalibrationRecord(
  recordEtaOutcome({
    displayed,
    etaRealizedSeconds: 850,
    lat: 6.5244,
    lng: 3.3792, // stored as the 0.1-degree bucket "6.5,3.4"
  }),
);
```

No wallet address, request id or exact coordinate is stored. To contribute to
the committed dataset, export with `exportCalibrationDataset()` and append the
redacted rows to `observations.json` with a new `collected` range.

## Regenerating the fit

1. Append new redacted observations to `data/eta-calibration/observations.json`.
2. Recompute the least-squares half-width and speed parameters (documented in
   `data/eta-calibration/README.md`).
3. Update **both** `src/lib/etaConstants.ts` and
   `data/eta-calibration/fitted-constants.json`, then re-run
   `npx vitest run test/eta-estimate.test.jsx`.
