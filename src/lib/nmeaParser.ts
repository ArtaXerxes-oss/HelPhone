/**
 * Minimal NMEA-0183 parser for Bluetooth GPS pucks (#803).
 *
 * Handles $xxGGA (position + HDOP + fix quality) and $xxRMC (speed/course),
 * any talker (GP, GN, GL...). Sentences with a bad checksum are dropped.
 * BLE notifications fragment sentences, so feed raw chunks into
 * `NmeaStream`, which reassembles on CRLF.
 */

export interface NmeaFix {
  lat: number
  lng: number
  /** Horizontal dilution of precision (GGA only) */
  hdop?: number
  /** Rough 1-sigma accuracy in metres derived from HDOP (UERE ≈ 5 m) */
  accuracy?: number
  satellites?: number
  /** Speed over ground, m/s (RMC only) */
  speed?: number
  course?: number
  sentence: 'GGA' | 'RMC'
}

const KNOTS_TO_MS = 0.514444
const UERE_METRES = 5

export function verifyChecksum(sentence: string): boolean {
  const match = sentence.trim().match(/^\$([^*]+)\*([0-9A-Fa-f]{2})$/)
  if (!match) return false
  let sum = 0
  for (let i = 0; i < match[1].length; i++) sum ^= match[1].charCodeAt(i)
  return sum === parseInt(match[2], 16)
}

/** ddmm.mmmm + hemisphere → signed decimal degrees */
function toDegrees(value: string, hemi: string, degDigits: number): number | null {
  if (!value || !hemi) return null
  const deg = Number(value.slice(0, degDigits))
  const min = Number(value.slice(degDigits))
  if (!Number.isFinite(deg) || !Number.isFinite(min)) return null
  const dec = deg + min / 60
  return hemi === 'S' || hemi === 'W' ? -dec : dec
}

export function parseNmeaSentence(sentence: string): NmeaFix | null {
  if (!verifyChecksum(sentence)) return null
  const fields = sentence.trim().slice(1, sentence.indexOf('*')).split(',')
  const type = fields[0].slice(-3)
  if (type === 'GGA') {
    const quality = Number(fields[6])
    if (!quality) return null // 0 = no fix
    const lat = toDegrees(fields[2], fields[3], 2)
    const lng = toDegrees(fields[4], fields[5], 3)
    if (lat == null || lng == null) return null
    const hdop = fields[8] ? Number(fields[8]) : undefined
    return {
      lat,
      lng,
      hdop,
      accuracy: hdop != null && Number.isFinite(hdop) ? hdop * UERE_METRES : undefined,
      satellites: fields[7] ? Number(fields[7]) : undefined,
      sentence: 'GGA',
    }
  }
  if (type === 'RMC') {
    if (fields[2] !== 'A') return null // V = void
    const lat = toDegrees(fields[3], fields[4], 2)
    const lng = toDegrees(fields[5], fields[6], 3)
    if (lat == null || lng == null) return null
    return {
      lat,
      lng,
      speed: fields[7] ? Number(fields[7]) * KNOTS_TO_MS : undefined,
      course: fields[8] ? Number(fields[8]) : undefined,
      sentence: 'RMC',
    }
  }
  return null
}

/** Reassembles fragmented BLE/serial chunks into sentences. */
export class NmeaStream {
  private buffer = ''

  push(chunk: string): NmeaFix[] {
    this.buffer += chunk
    const parts = this.buffer.split(/\r?\n/)
    this.buffer = parts.pop() ?? ''
    if (this.buffer.length > 512) this.buffer = '' // garbage, never a valid sentence
    const fixes: NmeaFix[] = []
    for (const part of parts) {
      const fix = part.startsWith('$') ? parseNmeaSentence(part) : null
      if (fix) fixes.push(fix)
    }
    return fixes
  }
}
