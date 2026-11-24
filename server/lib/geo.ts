/**
 * Geo helpers shared by the open-today slice, the hardware SOS gate and the
 * radio gateway. Pure functions, no I/O.
 */

const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'
const EARTH_RADIUS_KM = 6371

export interface LatLng {
  lat: number
  lng: number
}

/** Great-circle distance between two points, in kilometres (haversine). */
export function haversineKm(a: LatLng, b: LatLng): number {
  const toRad = Math.PI / 180
  const dLat = (b.lat - a.lat) * toRad
  const dLng = (b.lng - a.lng) * toRad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Standard base-32 geohash. Longitude and latitude bits are interleaved,
 * starting with longitude. Precision 11 (~1.5 m) is the default used by the
 * open-today slice.
 */
export function encodeGeohash(lat: number, lng: number, precision = 11): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new RangeError('geohash requires finite coordinates')
  }
  if (!Number.isInteger(precision) || precision < 1 || precision > 12) {
    throw new RangeError('geohash precision must be an integer from 1 to 12')
  }
  let latLo = -90
  let latHi = 90
  let lngLo = -180
  let lngHi = 180
  let evenBit = true
  let bitCount = 0
  let chunk = 0
  let out = ''
  while (out.length < precision) {
    if (evenBit) {
      const mid = (lngLo + lngHi) / 2
      if (lng >= mid) {
        chunk = (chunk << 1) | 1
        lngLo = mid
      } else {
        chunk <<= 1
        lngHi = mid
      }
    } else {
      const mid = (latLo + latHi) / 2
      if (lat >= mid) {
        chunk = (chunk << 1) | 1
        latLo = mid
      } else {
        chunk <<= 1
        latHi = mid
      }
    }
    evenBit = !evenBit
    bitCount += 1
    if (bitCount === 5) {
      out += GEOHASH_BASE32[chunk]
      bitCount = 0
      chunk = 0
    }
  }
  return out
}
