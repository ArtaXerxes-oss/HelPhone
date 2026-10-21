/**
 * Client mirror of the vault's zone differential-privacy policy (#529).
 *
 * `contracts/aegis_vault/src/privacy.rs` is the source of truth. It rejects a
 * zone whose bounding box is finer than the Laplace noise bound, whose edges are
 * off the grid, or that overlaps another zone in too small a region. These
 * helpers apply the same rules with the same integer semantics (BigInt, like
 * the contract's u64) so a UI can build a compliant zone and preflight it
 * instead of learning about a rejection from a failed transaction.
 *
 * Box edges are stored-coordinate integers:
 *   lon: floor(lon * 1e7) + 1_800_000_000  (0 ..= 3_600_000_000)
 *   lat: floor(lat * 1e7) +   900_000_000  (0 ..= 1_800_000_000)
 */
import type { ProofZone, ZonePrivacyParams, ZonePrivacyViolation } from '../types/index'
import { buildLocationProofZone } from './zk'

export const MAX_X = 3_600_000_000n
export const MAX_Y = 1_800_000_000n

/** Same defaults as `PrivacyParams::defaults()` on the contract (disabled). */
export const DEFAULT_ZONE_PRIVACY: ZonePrivacyParams = Object.freeze({
  enabled: false,
  epsilonMilli: 1_000,
  sensitivity: 100_000,
  tailMult: 3,
  grid: 10_000,
  kCells: 25,
})

/** A bounding box in stored-coordinate units. Strings, as `ProofZone` uses. */
export interface ZoneBox {
  boxXMin: string
  boxXMax: string
  boxYMin: string
  boxYMax: string
}

interface Edges {
  xMin: bigint
  xMax: bigint
  yMin: bigint
  yMax: bigint
}

export type ZoneCheck = { ok: true } | { ok: false; error: ZonePrivacyViolation }

const ok: ZoneCheck = { ok: true }
const fail = (error: ZonePrivacyViolation): ZoneCheck => ({ ok: false, error })

function edges(box: ZoneBox): Edges | null {
  try {
    const e = {
      xMin: BigInt(box.boxXMin),
      xMax: BigInt(box.boxXMax),
      yMin: BigInt(box.boxYMin),
      yMax: BigInt(box.boxYMax),
    }
    return Object.values(e).some((v) => v < 0n) ? null : e
  } catch {
    return null
  }
}

const big = (n: number): bigint => BigInt(Math.trunc(n))
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b

/** Laplace scale `b = ceil(sensitivity / epsilon)`; null when epsilon is 0. */
export function laplaceScale(p: ZonePrivacyParams): bigint | null {
  return p.epsilonMilli > 0 ? ceilDiv(big(p.sensitivity) * 1000n, big(p.epsilonMilli)) : null
}

/** Smallest allowed box side: `b * t`, rounded up to a whole grid cell. */
export function minBoxDimension(p: ZonePrivacyParams): bigint | null {
  const b = laplaceScale(p)
  if (b === null || p.grid <= 0) return null
  const grid = big(p.grid)
  return ceilDiv(b * big(p.tailMult), grid) * grid
}

/** Whether the parameters are usable (the contract refuses any others). */
export function validateParams(p: ZonePrivacyParams): ZoneCheck {
  if (p.sensitivity <= 0 || p.tailMult <= 0 || p.kCells <= 0) return fail('invalid_params')
  const min = minBoxDimension(p)
  // The smallest legal box has to fit on the map.
  return min !== null && min > 0n && min <= MAX_Y ? ok : fail('invalid_params')
}

/** Check one box against the Laplace bound and the grid. */
export function validateZone(box: ZoneBox, p: ZonePrivacyParams): ZoneCheck {
  const bad = validateParams(p)
  if (!bad.ok) return bad
  const e = edges(box)
  if (!e || e.xMin >= e.xMax || e.yMin >= e.yMax || e.xMax > MAX_X || e.yMax > MAX_Y) {
    return fail('malformed')
  }
  const grid = big(p.grid)
  if ([e.xMin, e.xMax, e.yMin, e.yMax].some((v) => v % grid !== 0n)) return fail('not_on_grid')
  const min = minBoxDimension(p)!
  if (e.xMax - e.xMin < min || e.yMax - e.yMin < min) return fail('too_small')
  return ok
}

/**
 * Two zones may be disjoint, or overlap by at least the Laplace bound per axis
 * and `kCells` grid cells. Boxes are closed, so touching edges intersect in a
 * line and are refused.
 */
export function checkOverlap(a: ZoneBox, b: ZoneBox, p: ZonePrivacyParams): ZoneCheck {
  const bad = validateParams(p)
  if (!bad.ok) return bad
  const ea = edges(a)
  const eb = edges(b)
  if (!ea || !eb) return fail('malformed')
  const max = (x: bigint, y: bigint) => (x > y ? x : y)
  const min = (x: bigint, y: bigint) => (x < y ? x : y)
  const xMin = max(ea.xMin, eb.xMin)
  const xMax = min(ea.xMax, eb.xMax)
  const yMin = max(ea.yMin, eb.yMin)
  const yMax = min(ea.yMax, eb.yMax)
  if (xMin > xMax || yMin > yMax) return ok // disjoint
  const w = xMax - xMin
  const h = yMax - yMin
  const grid = big(p.grid)
  const cells = (w / grid) * (h / grid)
  const minDim = minBoxDimension(p)!
  return w < minDim || h < minDim || cells < big(p.kCells) ? fail('overlap_too_small') : ok
}

/**
 * Grow a box until it satisfies the policy: snap every edge outward to the grid
 * (never inward, so the region only ever gets less precise), then widen each
 * axis symmetrically to the Laplace minimum, shifting rather than shrinking
 * when it meets the edge of the map. Returns null when no valid box exists.
 */
export function alignZone(box: ZoneBox, p: ZonePrivacyParams): ZoneBox | null {
  if (!validateParams(p).ok) return null
  const e = edges(box)
  if (!e) return null
  const grid = big(p.grid)
  const minDim = minBoxDimension(p)!

  const axis = (lo: bigint, hi: bigint, limit: bigint): [bigint, bigint] | null => {
    if (lo > hi) return null
    const top = (limit / grid) * grid // highest grid line on the map
    let a = (lo / grid) * grid // floor to the grid
    let b = ceilDiv(hi, grid) * grid // ceil to the grid
    if (b > top) b = top
    const short = minDim - (b - a)
    if (short > 0n) {
      const extra = ceilDiv(short, 2n * grid) * grid // per side, whole cells
      const lower = a - extra
      const upper = b + extra
      if (lower < 0n) {
        // Pin to the map edge and extend the far side only as far as needed.
        a = 0n
        b = b > minDim ? b : minDim
      } else if (upper > top) {
        b = top
        a = a < top - minDim ? a : top - minDim
      } else {
        a = lower
        b = upper
      }
    }
    return a >= 0n && b <= top && b - a >= minDim ? [a, b] : null
  }

  const x = axis(e.xMin, e.xMax, MAX_X)
  const y = axis(e.yMin, e.yMax, MAX_Y)
  if (!x || !y) return null
  return {
    boxXMin: String(x[0]),
    boxXMax: String(x[1]),
    boxYMin: String(y[0]),
    boxYMax: String(y[1]),
  }
}

/**
 * Like `buildLocationProofZone`, but the box is snapped to the vault's grid and
 * widened to its Laplace noise bound, so `fund_zone` accepts it when the
 * differential-privacy policy is enabled. Throws if no valid box fits.
 */
export function buildPrivateLocationProofZone({
  lat,
  lng,
  privacy,
  radiusMeters = 3000,
}: {
  lat: number
  lng: number
  privacy: ZonePrivacyParams
  radiusMeters?: number
}): ProofZone {
  const zone = buildLocationProofZone({ lat, lng, radiusMeters })
  const aligned = alignZone(zone, privacy)
  if (!aligned) {
    throw new Error('No zone satisfies the current privacy parameters at this location.')
  }
  return { ...zone, ...aligned }
}

/** Map the contract's `VaultError` numbers (13-17) to a violation. */
export function violationFromVaultError(code: number): ZonePrivacyViolation | null {
  switch (code) {
    case 13:
      return 'invalid_params'
    case 14:
      return 'malformed'
    case 15:
      return 'not_on_grid'
    case 16:
      return 'too_small'
    case 17:
      return 'overlap_too_small'
    default:
      return null
  }
}

/**
 * Redact PII from user profiles for public map display (ISP-053).
 * Only disclosed attributes pass through; undisclosed fields are stripped.
 */
export function redactProfile<T extends Record<string, any>>(
  profile: T,
  disclosedFields: string[] = ['nickname', 'id']
): Partial<T> {
  const redacted: Partial<T> = {}
  for (const field of disclosedFields) {
    if (field in profile) {
      redacted[field as keyof T] = profile[field]
    }
  }
  return redacted
}

/**
 * Add positional jitter to coordinates for k-anonymity (ISP-053).
 * Jitters coordinates by ±jitterMeters to prevent exact location tracking.
 */
export function jitterCoordinates(
  lat: number,
  lng: number,
  jitterMeters: number = 200
): { lat: number; lng: number } {
  // 1 degree latitude ≈ 111km
  const latJitter = (Math.random() - 0.5) * 2 * (jitterMeters / 111000)
  // Longitude degrees vary by latitude
  const lngJitter = (Math.random() - 0.5) * 2 * (jitterMeters / (111000 * Math.cos((lat * Math.PI) / 180)))
  return {
    lat: lat + latJitter,
    lng: lng + lngJitter,
  }
}
