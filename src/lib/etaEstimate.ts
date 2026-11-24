/**
 * Honest dispatch ETA estimation (ISP-105 / ADR-022).
 *
 * Fallback ETAs are returned as a range flagged low-confidence instead of a
 * single Haversine/constant-speed number, and responder fatigue scales pace.
 * The original planning constants below remain the canonical upstream API;
 * the fitted ADR-022 follow-up constants live in `etaConstants.ts` and are
 * used by the range-from-chain-ETA path added in this PR. All callers go
 * through `estimateEta`, so fatigue still only affects ranking here.
 */

import { FITTED_ETA_CONSTANTS } from './etaConstants.ts'

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

/** Canonical upstream estimator, kept intact for distance/source inputs. */
function estimateEtaBase(input: EtaInput): EtaEstimate {
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
    min: minMinutes,
    max: maxMinutes,
    confidence: degraded ? 'low' : 'normal',
    confidenceScore: degraded ? FITTED_ETA_CONSTANTS.minConfidence : FITTED_ETA_CONSTANTS.baseConfidence,
    degraded,
    label: degraded ? `${minMinutes}-${maxMinutes} min (estimate, offline)` : `${minMinutes}-${maxMinutes} min`,
  }
}

// ---------------------------------------------------------------------------
// ADR-022 follow-up additions (this PR). Interfaces merge with the ones above
// so existing consumers keep their original fields and types.
// ---------------------------------------------------------------------------

export interface EtaInput {
  /** Traffic-aware ETA from the chain, in seconds. Takes precedence over distance. */
  etaSeconds?: number | null
  /** Baseline responder speed in km/h for the chain-ETA path. */
  baseSpeedKmh?: number | null
  /** Fatigued runs for the chain-ETA path. */
  runs?: number
  /** False when traffic data is unavailable. */
  trafficAware?: boolean
  /** True on a forced Mapbox failure. */
  mapboxFailed?: boolean
  /** Explicit degraded override used by the UI. */
  degraded?: boolean
}

export interface EtaEstimate {
  /** Alias of `minMinutes` for the ADR-022 `{min,max,...}` shape. */
  min: number
  /** Alias of `maxMinutes`. */
  max: number
  /** Numeric confidence backing the `normal` / `low` level. */
  confidenceScore: number
}

export interface RankContext {
  lat: number
  lng: number
  runs?: number
  trafficAware?: boolean
  mapboxFailed?: boolean
  baseSpeedKmh?: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Great-circle distance in kilometres. */
export function haversineKm(a: [number, number], b: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[0] - a[0])
  const dLng = toRad(b[1] - a[1])
  const lat1 = toRad(a[0])
  const lat2 = toRad(b[0])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

/** Format one of our chain-ETA estimates for display. */
export function formatEta(estimate: Pick<EtaEstimate, 'min' | 'max' | 'degraded'>): string {
  if (estimate.max === 0) return 'ETA unavailable'
  const range = estimate.min === estimate.max ? `${estimate.min} min` : `${estimate.min}–${estimate.max} min`
  return estimate.degraded ? `≈${range} (offline)` : range
}

function withAliases(estimate: EtaEstimate): EtaEstimate {
  return {
    ...estimate,
    min: estimate.minMinutes,
    max: estimate.maxMinutes,
    confidenceScore: estimate.confidence === 'low' ? FITTED_ETA_CONSTANTS.minConfidence : FITTED_ETA_CONSTANTS.baseConfidence,
  }
}

/** Estimate from a chain ETA using the fitted ADR-022 constants. */
function estimateFromChainEta(input: EtaInput, constants = FITTED_ETA_CONSTANTS): EtaEstimate {
  const {
    etaSeconds,
    distanceKm,
    baseSpeedKmh,
    runs = 0,
    trafficAware = true,
    mapboxFailed = false,
    degraded: explicitDegraded,
  } = input
  const degraded = explicitDegraded ?? (!trafficAware || mapboxFailed || (!etaSeconds && !distanceKm))

  if (!etaSeconds && !distanceKm) {
    return {
      minMinutes: 0, maxMinutes: 0, min: 0, max: 0,
      confidence: 'low', confidenceScore: 0, degraded: true, label: 'ETA unavailable',
    }
  }

  const speed = clamp(Number(baseSpeedKmh ?? 28), constants.minSpeedKmh, constants.maxSpeedKmh)
  const fatigueRuns = clamp(Number(runs) || 0, 0, constants.runsToCap)
  let factor = Math.min(1 + fatigueRuns * constants.speedGainPerRun, constants.speedCapMultiplier)
  if (degraded) factor *= constants.degradedPenalty

  const rawMinutes = etaSeconds && etaSeconds > 0
    ? etaSeconds / 60
    : (Number(distanceKm) / speed) * 60
  const minutes = rawMinutes / factor
  const spread = constants.relativeSpread * (degraded ? constants.degradedSpreadMultiplier : 1)
  const minMinutes = Math.max(1, Math.round(minutes * (1 - spread)))
  const maxMinutes = Math.max(minMinutes + (degraded ? 2 : 1), Math.round(minutes * (1 + spread)))
  const confidenceScore = degraded
    ? constants.minConfidence
    : clamp(constants.baseConfidence - fatigueRuns * 0.015, constants.minConfidence, constants.baseConfidence)

  const base: EtaEstimate = {
    minMinutes, maxMinutes,
    min: minMinutes, max: maxMinutes,
    confidence: degraded ? 'low' : 'normal',
    confidenceScore, degraded, label: '',
  }
  const result = withAliases(base)
  result.confidenceScore = confidenceScore
  result.label = formatEta(result)
  return result
}

/**
 * Unified estimator. Distance/source inputs keep the canonical upstream
 * behaviour (and its label); chain-ETA inputs use the fitted ADR-022 range.
 */
export function estimateEta(input: EtaInput, constants = FITTED_ETA_CONSTANTS): EtaEstimate {
  if (input.source === 'traffic' || input.source === 'fallback') return withAliases(estimateEtaBase(input))
  if (input.etaSeconds != null || input.distanceKm != null || input.degraded !== undefined || input.runs !== undefined) {
    return estimateFromChainEta(input, constants)
  }
  // No usable data: degraded, unavailable range.
  return estimateFromChainEta({ ...input, etaSeconds: null, distanceKm: null }, constants)
}

/** Convert the legacy single-number ETA into a fitted range estimate. */
export function toEtaEstimate(
  etaSeconds: number | null | undefined,
  options: Omit<EtaInput, 'etaSeconds' | 'distanceKm' | 'source'> = {},
): EtaEstimate {
  return estimateFromChainEta({ distanceKm: 0, source: 'fallback', ...options, etaSeconds } as EtaInput)
}

/**
 * Order responder candidates by realistic ETA midpoint (fastest first), not
 * raw distance. Accepts the upstream `(candidates)` form and the ADR-022
 * `(candidates, context)` form used by Help.jsx; always returns fresh objects
 * carrying an `eta` field and never mutates its input.
 */
export function rankByRealisticEta<T extends EtaInput>(
  candidates: readonly T[],
  context?: RankContext,
): Array<T & { eta: EtaEstimate }> {
  return candidates
    .map((candidate, index) => {
      const estimate = context
        ? estimateEta({
            ...candidate,
            source: context.trafficAware === false || context.mapboxFailed ? 'fallback' : 'traffic',
            distanceKm: candidate.distanceKm ?? (candidate.lat != null && candidate.lng != null
              ? haversineKm([context.lat, context.lng], [candidate.lat as number, candidate.lng as number])
              : 0),
            consecutiveRuns: context.runs ?? candidate.consecutiveRuns,
          })
        : estimateEta(candidate)
      return { candidate, index, eta: estimate }
    })
    .sort((a, b) => {
      const byMidpoint = (a.eta.minMinutes + a.eta.maxMinutes) - (b.eta.minMinutes + b.eta.maxMinutes)
      return byMidpoint || a.index - b.index
    })
    .map(({ candidate, eta }) => ({ ...candidate, eta }))
}

/**
 * Gate for ETAs while history is still hydrating (#932). A partial history can
 * be missing the road closures and responder state that shape an ETA, so no
 * number is shown until actionable state is complete. Returns null in that case.
 */
export function estimateEtaWhileSyncing(
  input: EtaInput,
  { actionableComplete }: { actionableComplete: boolean },
): EtaEstimate | null {
  return actionableComplete ? estimateEta(input) : null
}

/** Allow a `lat`/`lng` candidate shape in ranking without breaking the EtaInput type. */
export interface EtaInput {
  lat?: number | null
  lng?: number | null
  id?: number | string
  responder?: string
  eta_seconds?: number | null
}
