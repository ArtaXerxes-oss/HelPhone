/**
 * Honest dispatch ETA estimation (ISP-105 / ADR-022).
 *
 * Fallback ETAs are returned as a range flagged low-confidence instead of a
 * single Haversine/constant-speed number, and responder fatigue scales pace.
 * All constants below are unvalidated planning assumptions, not measurements.
 */

export type EtaSource = 'traffic' | 'fallback'

export interface EtaInput {
  distanceKm: number
  source: EtaSource
  /** Consecutive completed requests for the responder. */
  consecutiveRuns?: number
  /** Multiplier >= 1 for known road closures on or near the route. */
  closurePenalty?: number
}

export interface EtaEstimate {
  minMinutes: number
  maxMinutes: number
  confidence: 'normal' | 'low'
  /** True when the number is not traffic-aware and the UI must style it differently. */
  degraded: boolean
  label: string
}

export const FATIGUE_THRESHOLD_RUNS = 5
export const FATIGUE_STEP = 0.1
export const FATIGUE_MAX_MULTIPLIER = 1.5
export const TRAFFIC_UNCERTAINTY = 0.15
export const FALLBACK_FAST_KMH = 40
export const FALLBACK_SLOW_KMH = 15

export function fatigueMultiplier(consecutiveRuns = 0): number {
  if (!Number.isFinite(consecutiveRuns) || consecutiveRuns < FATIGUE_THRESHOLD_RUNS) return 1
  const extra = (consecutiveRuns - FATIGUE_THRESHOLD_RUNS + 1) * FATIGUE_STEP
  return Math.min(1 + extra, FATIGUE_MAX_MULTIPLIER)
}

export function estimateEta(input: EtaInput): EtaEstimate {
  const { distanceKm, source } = input
  if (!Number.isFinite(distanceKm) || distanceKm < 0) throw new RangeError('distanceKm must be a non-negative number')
  const pace = fatigueMultiplier(input.consecutiveRuns)
  const closure = Math.max(1, input.closurePenalty ?? 1)
  let min: number
  let max: number
  if (source === 'traffic') {
    const point = (distanceKm / FALLBACK_FAST_KMH) * 60 * pace * closure
    min = point * (1 - TRAFFIC_UNCERTAINTY)
    max = point * (1 + TRAFFIC_UNCERTAINTY)
  } else {
    min = (distanceKm / FALLBACK_FAST_KMH) * 60 * pace
    max = (distanceKm / FALLBACK_SLOW_KMH) * 60 * pace * closure
  }
  const minMinutes = Math.max(1, Math.floor(min))
  const maxMinutes = Math.max(minMinutes, Math.ceil(max))
  const degraded = source !== 'traffic'
  return {
    minMinutes,
    maxMinutes,
    confidence: degraded ? 'low' : 'normal',
    degraded,
    label: degraded ? `${minMinutes}-${maxMinutes} min (estimate, offline)` : `${minMinutes}-${maxMinutes} min`,
  }
}

/** Orders candidates by realistic ETA midpoint (fastest first), not raw distance. */
export function rankByRealisticEta<T extends EtaInput>(candidates: T[]): Array<T & { eta: EtaEstimate }> {
  return candidates
    .map(candidate => ({ ...candidate, eta: estimateEta(candidate) }))
    .sort((a, b) => (a.eta.minMinutes + a.eta.maxMinutes) - (b.eta.minMinutes + b.eta.maxMinutes))
}
