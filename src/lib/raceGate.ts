/**
 * Multipath race gate (ISP-120).
 *
 * Pure policy: decides whether a dispatch-critical send may fire a redundant
 * second copy. It performs no I/O and does not send anything. Callers feed in
 * the current path state and the payload class. Scope is deliberately narrow:
 *   - P0 only; P1 and bulk never race
 *   - only after a single-path stall (not always-on)
 *   - vetoed on metered bearers and on low battery
 *   - capped races per rolling hour
 * The flag is VITE_MULTIPATH_RACE; when it is not "true", nothing races.
 */

export type PayloadClass = 'P0' | 'P1' | 'bulk'

export interface PathState {
  /** Observed latency of the primary path, in ms. */
  rttMs: number
  /** Stall reported by the RTT/heartbeat detector for the primary path. */
  stalled: boolean
  /** True when the active bearer is metered (capped data plan). */
  metered: boolean
}

export interface RaceContext {
  payload: PayloadClass
  path: PathState
  /** Battery level 0..1, or null when the Battery API is unavailable. */
  batteryLevel: number | null
  /** Races already fired in the last rolling hour. */
  racesLastHour: number
  /** Operator override to allow a metered race for P0 only. */
  operatorOverride: boolean
}

export type RaceDecision =
  | { race: true }
  | { race: false; reason: RaceVetoReason }

export type RaceVetoReason =
  | 'flag-off'
  | 'not-p0'
  | 'path-healthy'
  | 'metered-bearer'
  | 'low-battery'
  | 'hourly-cap'

export const RACE_MAX_PER_HOUR = 20
export const RACE_LOW_BATTERY_LEVEL = 0.2

/** Mirrors the flag env var; read once by the caller and passed in. */
export function isRaceFlagOn(rawEnv: string | undefined): boolean {
  return rawEnv === 'true'
}

export function decideRace(flagOn: boolean, ctx: RaceContext): RaceDecision {
  if (!flagOn) return { race: false, reason: 'flag-off' }
  if (ctx.payload !== 'P0') return { race: false, reason: 'not-p0' }
  if (!ctx.path.stalled) return { race: false, reason: 'path-healthy' }

  // Metered bearers are vetoed unless P0 plus an explicit operator override.
  // The payload is already P0 here, so the override alone unlocks it.
  if (ctx.path.metered && !ctx.operatorOverride) {
    return { race: false, reason: 'metered-bearer' }
  }

  if (ctx.batteryLevel !== null && ctx.batteryLevel < RACE_LOW_BATTERY_LEVEL) {
    return { race: false, reason: 'low-battery' }
  }

  if (ctx.racesLastHour >= RACE_MAX_PER_HOUR) {
    return { race: false, reason: 'hourly-cap' }
  }

  return { race: true }
}
