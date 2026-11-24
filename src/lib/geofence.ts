/**
 * Shelter polygon geofencing.
 *
 * Each shelter has a bounding polygon. Filings from kiosk mode are rejected
 * if the device GPS is outside the polygon (or more than GPS_SLOP_METRES
 * beyond its edge, to account for concrete-shelter GPS drift).
 *
 * The polygon check uses the ray-casting algorithm. All coordinates are
 * [lat, lng] pairs in decimal degrees.
 */

export interface ShelterPolygon {
  shelterId: string
  /** Display name shown in the kiosk banner */
  name: string
  /** Centre of the shelter, used for map bias */
  center: [number, number]
  /** Polygon vertices — closed ring (first === last is not required) */
  vertices: Array<[number, number]>
  /** Extra tolerance in metres on top of the polygon edge (default 50) */
  slopMetres?: number
}

/** Registry of known shelters. In production this would be fetched from the
 *  server/contract on boot and cached; for the kiosk MVP it is embedded. */
const SHELTER_REGISTRY: Record<string, ShelterPolygon> = {
  BRAVO: {
    shelterId: 'BRAVO',
    name: 'Shelter Bravo',
    center: [37.7749, -122.4194],
    vertices: [
      [37.776, -122.421],
      [37.776, -122.418],
      [37.773, -122.418],
      [37.773, -122.421],
    ],
    slopMetres: 50,
  },
  ALPHA: {
    shelterId: 'ALPHA',
    name: 'Shelter Alpha',
    center: [34.0522, -118.2437],
    vertices: [
      [34.053, -118.245],
      [34.053, -118.242],
      [34.051, -118.242],
      [34.051, -118.245],
    ],
    slopMetres: 50,
  },
}

export function getShelterPolygon(shelterId: string): ShelterPolygon | null {
  return SHELTER_REGISTRY[shelterId.toUpperCase()] ?? null
}

export function getShelterName(shelterId: string): string {
  return SHELTER_REGISTRY[shelterId.toUpperCase()]?.name ?? `Shelter ${shelterId}`
}

/**
 * Ray-casting point-in-polygon test.
 * Returns true when (lat, lng) is inside (or within slopMetres of) the polygon.
 */
export function isInsideShelterPolygon(
  lat: number,
  lng: number,
  polygon: ShelterPolygon,
): boolean {
  const { vertices, slopMetres = 50 } = polygon

  // Convert slop to approximate degrees (1° ≈ 111 km)
  const slopDeg = slopMetres / 111_000

  // Expand each vertex outward by slopDeg for the tolerance check.
  if (raycast(lat, lng, vertices)) return true

  // Also check the expanded bounding box as a fast-path before declaring OOB.
  const lats = vertices.map((v) => v[0])
  const lngs = vertices.map((v) => v[1])
  const minLat = Math.min(...lats) - slopDeg
  const maxLat = Math.max(...lats) + slopDeg
  const minLng = Math.min(...lngs) - slopDeg
  const maxLng = Math.max(...lngs) + slopDeg

  return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng
}

function raycast(lat: number, lng: number, vertices: Array<[number, number]>): boolean {
  let inside = false
  const n = vertices.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [yi, xi] = vertices[i]
    const [yj, xj] = vertices[j]
    const intersects =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

export type DwellEvent = 'enter' | 'exit' | null

/**
 * Dwell-debounced geofence state (#803). Drifting or switching position
 * sources flips raw containment many times a minute; only report `enter`
 * after `enterMs` continuously inside and `exit` after `exitMs` outside.
 */
export class GeofenceDwellTracker {
  private inside: boolean | null = null
  private pending: { inside: boolean; since: number } | null = null

  constructor(
    private readonly polygon: ShelterPolygon,
    private readonly enterMs = 10_000,
    private readonly exitMs = 20_000,
  ) {}

  get isInside(): boolean | null {
    return this.inside
  }

  update(lat: number, lng: number, now = Date.now()): DwellEvent {
    const raw = isInsideShelterPolygon(lat, lng, this.polygon)
    if (raw === this.inside) {
      this.pending = null
      return null
    }
    if (!this.pending || this.pending.inside !== raw) {
      this.pending = { inside: raw, since: now }
    }
    // First fix ever: adopt immediately so the UI is not blank for 10 s.
    const wait = this.inside === null ? 0 : raw ? this.enterMs : this.exitMs
    if (now - this.pending.since < wait) return null
    this.inside = raw
    this.pending = null
    return raw ? 'enter' : 'exit'
  }
}
