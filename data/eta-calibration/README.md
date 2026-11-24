# ETA calibration dataset

`observations.json` contains 24 redacted displayed-vs-realized ETA observations
collected 2026-11-01 → 2026-11-20 across three modes:

- **traffic** — route-aware ETA from the dispatch path;
- **offline** — traffic data unavailable, but a distance estimate existed;
- **fallback** — neither traffic nor distance was available.

Redaction: coordinates are rounded to 0.1° (roughly 11 km), no wallet address,
request id, or exact position is stored. The `area` field is therefore safe to
commit.

## Fit rationale

The original constants (5 runs, +10 %/run, 1.5× cap, ±15 %, 15–40 km/h) were
chosen without evidence. They produced 71 % coverage on the traffic-mode
observations: displayed ranges were too narrow at short distances and too
optimistic after fatigue.

Fitting to the observed midpoint error (least-squares on the half-width, with
a constraint that ≥85 % of traffic observations fall inside the range) gives:

| Constant                   | Legacy | Fitted | Why                                                        |
| -------------------------- | ------ | ------ | ---------------------------------------------------------- |
| `runsToCap`                | 5      | 6      | Fatigue saturation observed at run 6, not 5                |
| `speedGainPerRun`          | 0.10   | 0.085  | 10 %/run over-predicted speed for tired responders         |
| `speedCapMultiplier`       | 1.5    | 1.42   | 1.5× produced implausible < 4 min ETAs                     |
| `relativeSpread`           | 0.15   | 0.17   | Needed for ≥85 % traffic coverage                          |
| `minSpeedKmh`              | 15     | 13     | Observed slow starts in dense areas                        |
| `maxSpeedKmh`              | 40     | 37     | Upper tail of observed riding speeds                       |
| `degradedPenalty`          | 0.8    | 0.78   | Offline arrivals were ~22 % slower than traffic-aware ones |
| `degradedSpreadMultiplier` | 3      | 3.2    | Offline coverage was 62 % at 3×                            |
| `baseConfidence`           | 0.90   | 0.92   | Matches 90 % traffic coverage                              |
| `minConfidence`            | 0.40   | 0.45   | 40 % understated offline usefulness                        |

The fitted values are mirrored in `src/lib/etaConstants.ts` (the runtime copy)
and `fitted-constants.json` (the committed evidence copy). Regenerate them by
running the dashboard's "fit from dataset" action described in
`docs/eta-calibration-dashboard.md`.
