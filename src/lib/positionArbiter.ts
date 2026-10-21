/**
 * Position arbitration between a Bluetooth GPS puck, phone GPS and a manual
 * override (#803). Mapbox snap-to-road is display-only and never enters here.
 *
 * - Each source gets a confidence weight from accuracy and age.
 * - The active source only changes after the challenger has been better for
 *   `hysteresisMs` (5 s), or immediately if the active source goes stale.
 * - Output position is eased toward the new fix over `transitionMs` (800 ms)
 *   so pins never teleport across the map.
 */

export type PositionSource = 'puck' | 'phone' | 'manual'

export interface SourceFix {
  source: PositionSource
  lat: number
  lng: number
  /** 1-sigma accuracy in metres */
  accuracy: number
  hdop?: number
  /** ms epoch of the fix */
  at: number
}

export interface ArbitratedFix {
  lat: number
  lng: number
  accuracy: number
  source: PositionSource
  stale: boolean
  at: number
}

export interface ArbiterOptions {
  hysteresisMs?: number
  transitionMs?: number
  /** A source with no fix for this long is stale */
  staleMs?: number
  /** Puck only wins with HDOP below this */
  maxPuckHdop?: number
}

const DEFAULTS: Required<ArbiterOptions> = {
  hysteresisMs: 5_000,
  transitionMs: 800,
  staleMs: 10_000,
  maxPuckHdop: 2.0,
}

// Manual is lower trust than a good puck but beats drifting phone GPS.
const SOURCE_BIAS: Record<PositionSource, number> = { puck: 1.5, manual: 1.2, phone: 1 }

export function haversineMetres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000
  const toRad = Math.PI / 180
  const dLat = (bLat - aLat) * toRad
  const dLng = (bLng - aLng) * toRad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export class PositionArbiter {
  private readonly opts: Required<ArbiterOptions>
  private latest = new Map<PositionSource, SourceFix>()
  private active: PositionSource | null = null
  private challenger: { source: PositionSource; since: number } | null = null
  private from: { lat: number; lng: number } | null = null
  private to: SourceFix | null = null
  private transitionStart = 0

  constructor(options: ArbiterOptions = {}) {
    this.opts = { ...DEFAULTS, ...options }
  }

  weight(fix: SourceFix | undefined, now: number): number {
    if (!fix) return 0
    // A manual pin is a deliberate user choice: it does not age out.
    if (fix.source === 'manual') return SOURCE_BIAS.manual / Math.max(fix.accuracy, 1)
    const age = now - fix.at
    if (age > this.opts.staleMs) return 0
    if (fix.source === 'puck' && (fix.hdop ?? Infinity) >= this.opts.maxPuckHdop && age > 3_000) return 0.01
    const accuracy = Math.max(fix.accuracy || 50, 1)
    const freshness = 1 - age / this.opts.staleMs
    return (SOURCE_BIAS[fix.source] * freshness) / accuracy
  }

  push(fix: SourceFix, now = fix.at): void {
    this.latest.set(fix.source, fix)
    this.reconsider(now)
    if (fix.source === this.active) this.retarget(fix, now)
  }

  /** Drop a source, e.g. on puck GATT disconnect or manual override cleared. */
  remove(source: PositionSource, now = Date.now()): void {
    this.latest.delete(source)
    this.reconsider(now)
  }

  private reconsider(now: number): void {
    let best: PositionSource | null = null
    let bestW = 0
    for (const [source, fix] of this.latest) {
      const w = this.weight(fix, now)
      if (w > bestW) {
        best = source
        bestW = w
      }
    }
    if (!best || best === this.active) {
      this.challenger = null
      return
    }
    const activeLost = !this.active || this.weight(this.latest.get(this.active), now) === 0
    if (!activeLost) {
      if (this.challenger?.source !== best) {
        this.challenger = { source: best, since: now }
        return
      }
      if (now - this.challenger.since < this.opts.hysteresisMs) return
    }
    this.active = best
    this.challenger = null
    this.retarget(this.latest.get(best)!, now)
  }

  private retarget(fix: SourceFix, now: number): void {
    const current = this.current(now)
    this.from = current ? { lat: current.lat, lng: current.lng } : null
    this.to = fix
    this.transitionStart = now
  }

  /** Eased position for rendering at time `now`. */
  current(now = Date.now()): ArbitratedFix | null {
    if (!this.to) return null
    const t = this.from ? Math.min((now - this.transitionStart) / this.opts.transitionMs, 1) : 1
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2 // easeInOutQuad
    const from = this.from ?? this.to
    return {
      lat: from.lat + (this.to.lat - from.lat) * e,
      lng: from.lng + (this.to.lng - from.lng) * e,
      accuracy: this.to.accuracy,
      source: this.to.source,
      stale: this.to.source !== 'manual' && now - this.to.at > this.opts.staleMs,
      at: this.to.at,
    }
  }

  /** Raw (non-eased) arbitrated fix: what geofencing and persistence consume. */
  settled(now = Date.now()): ArbitratedFix | null {
    if (!this.to) return null
    return { ...this.to, stale: this.to.source !== 'manual' && now - this.to.at > this.opts.staleMs }
  }
}

/**
 * Persistence decimation: at most one fix per `intervalMs`, quantized to 5
 * decimals (~1 m), stale fixes never persisted as fresh.
 */
export function createTrailDecimator(intervalMs = 1_000) {
  let last = 0
  return (fix: ArbitratedFix | null): ArbitratedFix | null => {
    if (!fix || fix.stale || fix.at - last < intervalMs) return null
    last = fix.at
    const q = (n: number) => Math.round(n * 1e5) / 1e5
    return { ...fix, lat: q(fix.lat), lng: q(fix.lng) }
  }
}
