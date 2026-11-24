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

export interface OverlapDetails {
  disjoint: boolean
  width: bigint
  height: bigint
  cells: bigint
  minDim: bigint
  minCells: bigint
  ok: boolean
  error?: ZonePrivacyViolation
}

/**
 * Compute detailed overlap geometry between two zones with exact BigInt semantics.
 */
export function computeOverlap(
  a: ZoneBox,
  b: ZoneBox,
  p: ZonePrivacyParams = DEFAULT_ZONE_PRIVACY
): OverlapDetails {
  const ea = edges(a)
  const eb = edges(b)
  const minDim = minBoxDimension(p) || 0n
  const minCells = big(p.kCells || 25)

  if (!ea || !eb) {
    return {
      disjoint: false,
      width: 0n,
      height: 0n,
      cells: 0n,
      minDim,
      minCells,
      ok: false,
      error: 'malformed',
    }
  }

  const max = (x: bigint, y: bigint) => (x > y ? x : y)
  const min = (x: bigint, y: bigint) => (x < y ? x : y)
  const xMin = max(ea.xMin, eb.xMin)
  const xMax = min(ea.xMax, eb.xMax)
  const yMin = max(ea.yMin, eb.yMin)
  const yMax = min(ea.yMax, eb.yMax)

  if (xMin > xMax || yMin > yMax) {
    return {
      disjoint: true,
      width: 0n,
      height: 0n,
      cells: 0n,
      minDim,
      minCells,
      ok: true,
    }
  }

  const w = xMax - xMin
  const h = yMax - yMin
  const grid = big(p.grid || 10_000)
  const cells = grid > 0n ? (w / grid) * (h / grid) : 0n
  const ok = w >= minDim && h >= minDim && cells >= minCells

  return {
    disjoint: false,
    width: w,
    height: h,
    cells,
    minDim,
    minCells,
    ok,
    error: ok ? undefined : 'overlap_too_small',
  }
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

export interface BuildCampaignZoneParams {
  bounds?: ZoneBox
  lat?: number
  lng?: number
  radiusMeters?: number
  campaignId?: string
  privacy?: ZonePrivacyParams
  existingZones?: ZoneBox[]
}

export type BuildCampaignZoneResult =
  | {
      ok: true
      zone: ProofZone
      box: ZoneBox
      aligned: boolean
      preflight: { valid: true }
    }
  | {
      ok: false
      error: ZonePrivacyViolation
      reason: string
      minDimension: bigint
      proposedBox?: ZoneBox
    }

/**
 * Builds and preflights a campaign zone under differential privacy rules.
 * Snaps edges outward to the grid and widens to the Laplace floor rather than shrinking.
 * Checks Laplace, grid alignment, map boundaries, and k-anonymity overlap.
 */
export function buildCampaignZone(params: BuildCampaignZoneParams): BuildCampaignZoneResult {
  const privacy = params.privacy ?? DEFAULT_ZONE_PRIVACY
  const minDim = minBoxDimension(privacy) || 300_000n

  let initialBox: ZoneBox
  let initialZone: ProofZone | null = null

  if (params.bounds) {
    initialBox = params.bounds
  } else if (params.lat !== undefined && params.lng !== undefined) {
    initialZone = buildLocationProofZone({
      lat: params.lat,
      lng: params.lng,
      radiusMeters: params.radiusMeters ?? 3000,
    })
    initialBox = {
      boxXMin: initialZone.boxXMin,
      boxXMax: initialZone.boxXMax,
      boxYMin: initialZone.boxYMin,
      boxYMax: initialZone.boxYMax,
    }
  } else {
    return {
      ok: false,
      error: 'malformed',
      reason: 'Either bounds or lat/lng must be provided to build a campaign zone.',
      minDimension: minDim,
    }
  }

  // If privacy is disabled on the vault, return the raw or aligned box
  if (!privacy.enabled) {
    const zone: ProofZone = initialZone ?? {
      ...initialBox,
      campaignId: params.campaignId ?? '0',
    }
    return {
      ok: true,
      zone,
      box: initialBox,
      aligned: false,
      preflight: { valid: true },
    }
  }

  // Snap edges outward to grid and widen symmetrically to Laplace floor (never shrinks)
  const alignedBox = alignZone(initialBox, privacy)
  if (!alignedBox) {
    return {
      ok: false,
      error: 'too_small',
      reason: `Could not align zone to satisfy minimum dimension of ${minDim} units on map.`,
      minDimension: minDim,
      proposedBox: initialBox,
    }
  }

  // Validate zone rules
  const val = validateZone(alignedBox, privacy)
  if (!val.ok) {
    const reasons: Record<ZonePrivacyViolation, string> = {
      invalid_params: 'Vault privacy policy parameters are invalid.',
      malformed: 'Zone coordinates are outside valid map boundaries.',
      not_on_grid: `Zone boundary edges are not aligned to grid (${privacy.grid} units).`,
      too_small: `Zone dimension is smaller than required Laplace privacy floor (${minDim} units).`,
      overlap_too_small: 'Zone overlap violates k-anonymity requirement.',
    }
    return {
      ok: false,
      error: val.error,
      reason: reasons[val.error] || 'Zone validation failed against privacy policy.',
      minDimension: minDim,
      proposedBox: alignedBox,
    }
  }

  // Check overlap with existing active zones
  if (params.existingZones && params.existingZones.length > 0) {
    for (const existing of params.existingZones) {
      const ov = checkOverlap(alignedBox, existing, privacy)
      if (!ov.ok) {
        return {
          ok: false,
          error: 'overlap_too_small',
          reason: `Zone overlaps an existing campaign zone by less than ${minDim} units or fewer than ${privacy.kCells} cells, violating k-anonymity.`,
          minDimension: minDim,
          proposedBox: alignedBox,
        }
      }
    }
  }

  const finalZone: ProofZone = {
    ...alignedBox,
    campaignId: params.campaignId ?? (initialZone?.campaignId || '0'),
  }

  return {
    ok: true,
    zone: finalZone,
    box: alignedBox,
    aligned: true,
    preflight: { valid: true },
  }
}
