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

export interface NavigatorConnectionLike {
  metered?: boolean
  isMetered?: boolean
  saveData?: boolean
  type?: string
  effectiveType?: string
}

export interface NavigatorBatteryLike {
  level?: number
  charging?: boolean
  addEventListener?: (type: string, listener: () => void) => void
}

export interface NavigatorWithSignals {
  getConnection?: () => NavigatorConnectionLike | null | undefined
  connection?: NavigatorConnectionLike | null
  mozConnection?: NavigatorConnectionLike | null
  webkitConnection?: NavigatorConnectionLike | null
  getBattery?: () => Promise<NavigatorBatteryLike | null | undefined>
  battery?: NavigatorBatteryLike | null
}

/**
 * Reads the active NetworkInformation object via `navigator.getConnection()`
 * or `navigator.connection` (and vendor-prefixed fallbacks).
 */
export function readConnection(
  nav: NavigatorWithSignals | null | undefined = typeof navigator !== 'undefined'
    ? (navigator as unknown as NavigatorWithSignals)
    : null,
): NavigatorConnectionLike | null {
  if (!nav) return null
  try {
    if (typeof nav.getConnection === 'function') {
      return nav.getConnection() ?? null
    }
    return nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null
  } catch {
    return null
  }
}

/**
 * Extracts the metered-bearer veto signal from `navigator.getConnection()` /
 * `navigator.connection`.
 */
export function readMeteredSignal(
  nav: NavigatorWithSignals | null | undefined = typeof navigator !== 'undefined'
    ? (navigator as unknown as NavigatorWithSignals)
    : null,
): boolean {
  const conn = readConnection(nav)
  if (!conn) return false
  return Boolean(conn.metered || conn.isMetered || conn.saveData)
}

/**
 * Reads synchronous battery level if already attached or cached.
 */
export function readSyncBatteryLevel(
  nav: NavigatorWithSignals | null | undefined,
  cachedLevel: number | null = null,
): number | null {
  try {
    const syncLevel = nav?.battery?.level
    if (typeof syncLevel === 'number' && Number.isFinite(syncLevel)) {
      return syncLevel
    }
  } catch {
    // ignore
  }
  return cachedLevel
}

/**
 * Asynchronously reads battery level (0..1) from `navigator.getBattery()`.
 * Returns null when the Battery API is unavailable or rejects.
 */
export async function readBatteryLevel(
  nav: NavigatorWithSignals | null | undefined = typeof navigator !== 'undefined'
    ? (navigator as unknown as NavigatorWithSignals)
    : null,
): Promise<number | null> {
  if (!nav) return null
  const sync = readSyncBatteryLevel(nav, null)
  if (sync !== null) return sync
  if (typeof nav.getBattery !== 'function') return null
  try {
    const battery = await nav.getBattery()
    const level = battery?.level
    return typeof level === 'number' && Number.isFinite(level) ? level : null
  } catch {
    return null
  }
}

export interface RaceHourTracker {
  count(at?: number): number
  record(at?: number): void
  reset(): void
}

/** Rolling 1-hour race counter used to enforce RACE_MAX_PER_HOUR. */
export function createRaceTracker(
  now: () => number = () => Date.now(),
  windowMs = 3_600_000,
): RaceHourTracker {
  const timestamps: number[] = []
  const prune = (at: number) => {
    while (timestamps.length > 0 && at - timestamps[0] >= windowMs) {
      timestamps.shift()
    }
  }
  return {
    count(at = now()): number {
      prune(at)
      return timestamps.length
    },
    record(at = now()): void {
      prune(at)
      timestamps.push(at)
    },
    reset(): void {
      timestamps.length = 0
    },
  }
}
