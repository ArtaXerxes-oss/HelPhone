/**
 * ETA calibration recorder (ADR-022 risks follow-up).
 *
 * Records the displayed range alongside the realized arrival time so the
 * calibration dashboard can compare them by mode. Location is bucketed before
 * storage and no wallet address, request id or exact coordinate is retained.
 */

import type { EtaEstimate } from './etaEstimate'

export type CalibrationMode = 'traffic' | 'offline' | 'fallback'
const STORAGE_KEY = 'helphone:eta-calibration'
const MAX_RECORDS = 500

export interface CalibrationRecord {
  ts: number
  mode: CalibrationMode
  /** 0.1-degree geohash-style bucket; never an exact coordinate. */
  area: string
  displayedMin: number
  displayedMax: number
  confidence: 'normal' | 'low'
  confidenceScore: number
  degraded: boolean
  etaRealizedSeconds: number
  /** Absolute error against the midpoint of the displayed range, seconds. */
  errorSeconds: number
  withinRange: boolean
}

export interface ModeSummary {
  mode: CalibrationMode
  count: number
  meanAbsErrorMin: number
  meanRangeWidthMin: number
  coveragePct: number
}

/** Redact a coordinate to a coarse 0.1-degree bucket. */
export function redactArea(lat: number | null | undefined, lng: number | null | undefined): string {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return 'unknown'
  const latBucket = Math.round(lat * 10) / 10
  const lngBucket = Math.round(lng * 10) / 10
  return `${latBucket.toFixed(1)},${lngBucket.toFixed(1)}`
}

export function recordEtaOutcome(input: {
  displayed: EtaEstimate
  etaRealizedSeconds: number
  mode?: CalibrationMode
  lat?: number | null
  lng?: number | null
  ts?: number
}): CalibrationRecord {
  const { displayed, etaRealizedSeconds } = input
  const midpointMin = (displayed.min + displayed.max) / 2
  const realizedMin = etaRealizedSeconds / 60
  const mode: CalibrationMode = input.mode ?? (displayed.degraded ? 'offline' : 'traffic')
  return {
    ts: input.ts ?? Date.now(),
    mode,
    area: redactArea(input.lat, input.lng),
    displayedMin: displayed.min,
    displayedMax: displayed.max,
    confidence: displayed.confidence,
    confidenceScore: displayed.confidenceScore,
    degraded: displayed.degraded,
    etaRealizedSeconds,
    errorSeconds: Math.round(Math.abs(realizedMin - midpointMin) * 60),
    withinRange: realizedMin >= displayed.min && realizedMin <= displayed.max,
  }
}

/** Aggregate by mode for the dashboard. Pure and deterministic. */
export function summarizeByMode(records: readonly CalibrationRecord[]): ModeSummary[] {
  const modes: CalibrationMode[] = ['traffic', 'offline', 'fallback']
  return modes.map((mode) => {
    const group = records.filter((r) => r.mode === mode)
    if (!group.length) return { mode, count: 0, meanAbsErrorMin: 0, meanRangeWidthMin: 0, coveragePct: 0 }
    const mean = (fn: (r: CalibrationRecord) => number) => group.reduce((sum, r) => sum + fn(r), 0) / group.length
    return {
      mode,
      count: group.length,
      meanAbsErrorMin: Math.round((mean((r) => r.errorSeconds / 60)) * 10) / 10,
      meanRangeWidthMin: Math.round((mean((r) => r.displayedMax - r.displayedMin)) * 10) / 10,
      coveragePct: Math.round((group.filter((r) => r.withinRange).length / group.length) * 100),
    }
  })
}

/** Append a record locally, capped to bound storage. */
export function appendCalibrationRecord(record: CalibrationRecord): CalibrationRecord[] {
  const all = loadCalibrationRecords()
  const next = [...all, record].slice(-MAX_RECORDS)
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* storage disabled — in-memory return is still useful to the caller */
  }
  return next
}

export function loadCalibrationRecords(): CalibrationRecord[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function clearCalibrationRecords(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* nothing to clear */
  }
}

/** Serialised, redacted export for contributing to the committed dataset. */
export function exportCalibrationDataset(records: readonly CalibrationRecord[]) {
  return records.map(({ ts, mode, area, displayedMin, displayedMax, confidence, degraded, etaRealizedSeconds }) => ({
    ts, mode, area, displayedMin, displayedMax, confidence, degraded, eta_realized: etaRealizedSeconds,
  }))
}
