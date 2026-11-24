/**
 * Pure ETA estimator and candidate ranking (ADR-022 main integration work).
 *
 * A single-number ETA is replaced by a bounded range plus an explicit
 * confidence/degraded flag. Fatigue is applied ONLY here — ranking calls this
 * estimator and never reads a fatigue value directly, so the two stay in sync.
 */

import { FITTED_ETA_CONSTANTS, type EtaConstants } from './etaConstants.ts'

export interface EtaEstimate {
  /** Lower bound in whole minutes. */
  min: number
  /** Upper bound in whole minutes (always >= min). */
  max: number
  /** 0..1 confidence in the range. */
  confidence: number
  /** True for offline/fallback estimates. */
  degraded: boolean
  /** Human-readable label suitable for direct rendering. */
  label: string
}

export interface EtaInput {
  /** Traffic-aware ETA from the chain, in seconds. */
  etaSeconds?: number | null
  /** Straight-line or routed distance; used when no ETA is available. */
  distanceKm?: number | null
  /** Baseline responder speed in km/h. */
  baseSpeedKmh?: number | null
  /** Fatigued runs; affects ranking only through this estimator. */
  runs?: number
  /** False when traffic data is unavailable. */
  trafficAware?: boolean
  /** True on a forced Mapbox/geocoding failure (E2E and degraded fallback). */
  mapboxFailed?: boolean
  /** Explicit override used by the UI when upstream data is known to be fallback data. */
  degraded?: boolean
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

/** Format an estimate for display. Kept separate so tests can pin the text. */
export function formatEta(estimate: EtaEstimate): string {
  if (estimate.max === 0) return 'ETA unavailable'
  const range = estimate.min === estimate.max ? `${estimate.min} min` : `${estimate.min}–${estimate.max} min`
  return estimate.degraded ? `≈${range} (offline)` : range
}

/**
 * Estimate an arrival range. Pure and deterministic.
 */
export function estimateEta(input: EtaInput, constants: Readonly<EtaConstants> = FITTED_ETA_CONSTANTS): EtaEstimate {
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
    return { min: 0, max: 0, confidence: 0, degraded: true, label: formatEta({ min: 0, max: 0, confidence: 0, degraded: true, label: '' }) }
  }

  const speed = clamp(
    Number(baseSpeedKmh ?? 28),
    constants.minSpeedKmh,
    constants.maxSpeedKmh,
  )
  const fatigueRuns = clamp(Number(runs) || 0, 0, constants.runsToCap)
  let factor = 1 + fatigueRuns * constants.speedGainPerRun
  factor = Math.min(factor, constants.speedCapMultiplier)
  if (degraded) factor *= constants.degradedPenalty

  const rawMinutes = etaSeconds && etaSeconds > 0
    ? etaSeconds / 60
    : (Number(distanceKm) / speed) * 60
  const minutes = rawMinutes / factor

  const spread = constants.relativeSpread * (degraded ? constants.degradedSpreadMultiplier : 1)
  const min = Math.max(1, Math.round(minutes * (1 - spread)))
  const max = Math.max(min + (degraded ? 2 : 1), Math.round(minutes * (1 + spread)))

  const confidence = degraded
    ? constants.minConfidence
    : clamp(constants.baseConfidence - fatigueRuns * 0.015, constants.minConfidence, constants.baseConfidence)

  const estimate: EtaEstimate = { min, max, confidence, degraded, label: '' }
  estimate.label = formatEta(estimate)
  return estimate
}

/** Convert the legacy single-number ETA into a range estimate. */
export function toEtaEstimate(
  etaSeconds: number | null | undefined,
  options: Omit<EtaInput, 'etaSeconds'> = {},
  constants?: Readonly<EtaConstants>,
): EtaEstimate {
  return estimateEta({ ...options, etaSeconds }, constants)
}

/**
 * Order responder candidates by their realistic (fatigue-adjusted) ETA.
 * Returns a new array; input order is preserved for equal estimates.
 */
export function rankByRealisticEta<T extends {
  responder?: string
  lat?: number | null
  lng?: number | null
  eta_seconds?: number | null
}>(
  candidates: readonly T[],
  context: RankContext,
  constants?: Readonly<EtaConstants>,
): T[] {
  return candidates
    .map((candidate, index) => {
      const hasCoords = candidate.lat != null && candidate.lng != null
      const distanceKm = hasCoords
        ? haversineKm([context.lat, context.lng], [candidate.lat as number, candidate.lng as number])
        : null
      const estimate = estimateEta({
        etaSeconds: candidate.eta_seconds,
        distanceKm,
        baseSpeedKmh: context.baseSpeedKmh,
        runs: context.runs,
        trafficAware: context.trafficAware,
        mapboxFailed: context.mapboxFailed,
      }, constants)
      return { candidate, index, estimate }
    })
    .sort((a, b) => {
      const byMin = a.estimate.min - b.estimate.min
      if (byMin) return byMin
      const byMax = a.estimate.max - b.estimate.max
      return byMax || a.index - b.index
    })
    .map((entry) => entry.candidate)
}
