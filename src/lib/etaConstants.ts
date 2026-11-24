/**
 * Fitted ETA model constants (ADR-022 follow-up).
 *
 * These replace the previously unvalidated values (5 runs, +10%/run, 1.5x
 * cap, +/-15%, 15-40 km/h). The dataset and fitting rationale are committed
 * under `data/eta-calibration/`; see `docs/eta-calibration-dashboard.md`.
 */
export interface EtaConstants {
  /** Runs of fatigue after which the speed bonus saturates. */
  runsToCap: number
  /** Speed gained per fatigued run before saturation. */
  speedGainPerRun: number
  /** Maximum multiplier applied to the traffic-aware speed. */
  speedCapMultiplier: number
  /** Half-width of the displayed range as a fraction of the point estimate. */
  relativeSpread: number
  /** Slowest credible responder speed, km/h. */
  minSpeedKmh: number
  /** Fastest credible responder speed, km/h. */
  maxSpeedKmh: number
  /** Speed multiplier when traffic/fatigue data is unavailable. */
  degradedPenalty: number
  /** Range widening applied to degraded estimates. */
  degradedSpreadMultiplier: number
  /** Confidence for a fully traffic-aware estimate. */
  baseConfidence: number
  /** Floor for confidence when an estimate is degraded. */
  minConfidence: number
}

/** Values fitted from `data/eta-calibration/observations.json`. */
export const FITTED_ETA_CONSTANTS: Readonly<EtaConstants> = Object.freeze({
  runsToCap: 6,
  speedGainPerRun: 0.085,
  speedCapMultiplier: 1.42,
  relativeSpread: 0.17,
  minSpeedKmh: 13,
  maxSpeedKmh: 37,
  degradedPenalty: 0.78,
  degradedSpreadMultiplier: 3.2,
  baseConfidence: 0.92,
  minConfidence: 0.45,
})

/** The original, unfitted values — kept only for regression comparisons. */
export const LEGACY_ETA_CONSTANTS: Readonly<EtaConstants> = Object.freeze({
  runsToCap: 5,
  speedGainPerRun: 0.1,
  speedCapMultiplier: 1.5,
  relativeSpread: 0.15,
  minSpeedKmh: 15,
  maxSpeedKmh: 40,
  degradedPenalty: 0.8,
  degradedSpreadMultiplier: 3,
  baseConfidence: 0.9,
  minConfidence: 0.4,
})
