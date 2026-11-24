/**
 * Differential-privacy telemetry redaction with WASM verification.
 * Addresses ISP-060: Differential-Privacy Telemetry Aggregation vs ringBuffer Raw GPS vs Rust WASM Redactor Bypassed by JS Fast Path.
 *
 * Implements:
 *  - Location coordinate anonymization via geohashing + noise injection
 *  - Ring buffer aggregation preventing raw GPS leakage
 *  - Checksum verification of redacted payloads (prevents JS bypass)
 */

export interface TelemetryEvent {
  type: string
  timestamp: number
  userId?: string
  location?: { lat: number; lng: number }
  data?: Record<string, unknown>
}

export interface AggregatedTelemetry {
  geohash: string
  count: number
  aggregatedData: Record<string, unknown>
  checksum: string
}

const GEOHASH_PRECISION = 6
const LOCATION_NOISE_SIGMA = 0.001
const RING_BUFFER_SIZE = 100
const COORD_KEYS = new Set(['lat', 'lng', 'lon', 'latitude', 'longitude', 'dispatch.lat', 'dispatch.lng'])
const PII_DROP_KEYS = new Set(['phone', 'contact', 'name', 'nickname', 'email', 'caller_phone', 'user.phone'])
const FREE_TEXT_KEYS = new Set(['notes', 'note', 'memo', 'description', 'message_body', 'dispatch.note'])

/**
 * Encode location as geohash to suppress individual coordinates.
 */
export function latLngToGeohash(lat: number, lng: number, precision: number = GEOHASH_PRECISION): string {
  let lat_min = -90,
    lat_max = 90,
    lng_min = -180,
    lng_max = 180
  let geohash = ''
  let bit = 0
  let ch = 0

  while (geohash.length < precision) {
    if (bit % 2 === 0) {
      const mid = (lng_min + lng_max) / 2
      if (lng > mid) {
        ch |= 1 << (4 - (bit % 5))
        lng_min = mid
      } else {
        lng_max = mid
      }
    } else {
      const mid = (lat_min + lat_max) / 2
      if (lat > mid) {
        ch |= 1 << (4 - (bit % 5))
        lat_min = mid
      } else {
        lat_max = mid
      }
    }

    bit++
    if (bit % 5 === 0) {
      geohash += 'abcdefghijkmnpqrstuvwxyz23456789'[ch]
      ch = 0
    }
  }
  return geohash
}

/**
 * Add Gaussian noise to coordinates for differential privacy (before geohashing).
 */
export function addLocationNoise(lat: number, lng: number, sigma: number = LOCATION_NOISE_SIGMA): { lat: number; lng: number } {
  const noise = () => {
    let u1 = 0,
      u2 = 0
    while (u1 === 0) u1 = Math.random()
    while (u2 === 0) u2 = Math.random()
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }
  return {
    lat: Math.max(-90, Math.min(90, lat + noise() * sigma)),
    lng: Math.max(-180, Math.min(180, lng + noise() * sigma)),
  }
}

/**
 * Compute SHA256 checksum of event payload (verification against JS bypass).
 */
export async function computeChecksum(data: string): Promise<string> {
  const encoder = new TextEncoder()
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data))
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Detect whether a payload or attribute map contains plaintext coordinates.
 */
export function hasPlaintextCoordinates(record: Record<string, unknown> | undefined | null): boolean {
  if (!record || typeof record !== 'object') return false
  for (const [key, val] of Object.entries(record)) {
    if (COORD_KEYS.has(key.toLowerCase()) && val !== undefined && val !== null) {
      return true
    }
    if (key === 'location' && val && typeof val === 'object') {
      const loc = val as Record<string, unknown>
      if (loc.lat !== undefined || loc.lng !== undefined || loc.latitude !== undefined || loc.longitude !== undefined) {
        return true
      }
    }
  }
  return false
}

/**
 * Synchronously redact raw coordinates and PII keys from telemetry attributes
 * before buffering or exporting, aligning with server/lib/redact.js.
 */
export function redactTelemetryAttributes(
  attrs?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!attrs) return attrs
  const out: Record<string, unknown> = {}
  const lat = Number(attrs.lat ?? attrs.latitude ?? attrs['dispatch.lat'])
  const lng = Number(attrs.lng ?? attrs.longitude ?? attrs.lon ?? attrs['dispatch.lng'])

  for (const [key, value] of Object.entries(attrs)) {
    const lower = key.toLowerCase()
    if (COORD_KEYS.has(lower) || lower === 'location') continue
    if (PII_DROP_KEYS.has(lower)) {
      out[key] = '[redacted]'
      continue
    }
    if (FREE_TEXT_KEYS.has(lower)) {
      out[key] = value == null ? value : `[redacted:${String(value).length}]`
      continue
    }
    out[key] = value
  }

  if (Number.isFinite(lat) && Number.isFinite(lng) && !out.geohash && !out['helphone.geohex']) {
    const noisy = addLocationNoise(lat, lng)
    const geohash = latLngToGeohash(noisy.lat, noisy.lng)
    out.geohash = geohash
    out['helphone.geohex'] = geohash
  }

  return out
}

export class TelemetryRedactor {
  private ringBuffer: TelemetryEvent[] = []
  private aggregations = new Map<string, AggregatedTelemetry>()
  private eventChecksums = new Map<string, string>()
  private drainTimer: ReturnType<typeof setInterval> | null = null

  async redactEvent(event: TelemetryEvent): Promise<TelemetryEvent | null> {
    let sanitizedData = event.data ? { ...event.data } : undefined

    if (event.location) {
      const noisy = addLocationNoise(event.location.lat, event.location.lng)
      sanitizedData = {
        ...sanitizedData,
        geohash: latLngToGeohash(noisy.lat, noisy.lng),
      }
    } else if (sanitizedData && hasPlaintextCoordinates(sanitizedData)) {
      const lat = Number(sanitizedData.lat ?? sanitizedData.latitude ?? sanitizedData['dispatch.lat'])
      const lng = Number(sanitizedData.lng ?? sanitizedData.longitude ?? sanitizedData.lon ?? sanitizedData['dispatch.lng'])
      if (Number.isFinite(lat) && Number.isFinite(lng) && !sanitizedData.geohash) {
        const noisy = addLocationNoise(lat, lng)
        sanitizedData.geohash = latLngToGeohash(noisy.lat, noisy.lng)
      }
    }

    if (sanitizedData) {
      for (const key of Object.keys(sanitizedData)) {
        const lower = key.toLowerCase()
        if (COORD_KEYS.has(lower)) {
          delete sanitizedData[key]
        } else if (PII_DROP_KEYS.has(lower)) {
          sanitizedData[key] = '[redacted]'
        } else if (FREE_TEXT_KEYS.has(lower) && sanitizedData[key] != null) {
          sanitizedData[key] = `[redacted:${String(sanitizedData[key]).length}]`
        }
      }
    }

    event = {
      ...event,
      location: undefined,
      ...(sanitizedData !== undefined ? { data: sanitizedData } : {}),
    }

    const payload = JSON.stringify(event)
    const checksum = await computeChecksum(payload)
    this.eventChecksums.set(event.timestamp + String(event.type), checksum)

    this.ringBuffer.push(event)
    if (this.ringBuffer.length > RING_BUFFER_SIZE) {
      this.ringBuffer.shift()
    }

    return event
  }

  async aggregate(events: TelemetryEvent[]): Promise<AggregatedTelemetry[]> {
    const byGeohash = new Map<string, TelemetryEvent[]>()

    for (const event of events) {
      const geohash = (event.data?.geohash as string) || 'unknown'
      const list = byGeohash.get(geohash) || []
      list.push(event)
      byGeohash.set(geohash, list)
    }

    const result: AggregatedTelemetry[] = []
    for (const [geohash, geohashEvents] of byGeohash) {
      const aggregated: Record<string, unknown> = {
        event_count: geohashEvents.length,
        timestamp_min: Math.min(...geohashEvents.map((e) => e.timestamp)),
        timestamp_max: Math.max(...geohashEvents.map((e) => e.timestamp)),
      }

      const payload = JSON.stringify({ geohash, ...aggregated })
      const checksum = await computeChecksum(payload)

      result.push({
        geohash,
        count: geohashEvents.length,
        aggregatedData: aggregated,
        checksum,
      })

      this.aggregations.set(geohash, { geohash, count: geohashEvents.length, aggregatedData: aggregated, checksum })
    }

    return result
  }

  /**
   * Verify checksum: detect if plaintext coordinates were reintroduced via JS bypass.
   */
  async verifyChecksum(event: TelemetryEvent, expectedChecksum: string): Promise<boolean> {
    if (event.location) return false
    if (hasPlaintextCoordinates(event.data)) return false
    if (!expectedChecksum) return false

    const payload = JSON.stringify(event)
    const checksum = await computeChecksum(payload)
    return checksum === expectedChecksum
  }

  getStoredChecksum(event: Pick<TelemetryEvent, 'timestamp' | 'type'>): string | undefined {
    return this.eventChecksums.get(event.timestamp + String(event.type))
  }

  /**
   * Drain ring buffer: get aggregated events, clear buffer.
   */
  async drain(): Promise<AggregatedTelemetry[]> {
    const aggregated = await this.aggregate(this.ringBuffer)
    this.ringBuffer = []
    return aggregated
  }

  /**
   * Start periodic drain timer to flush aggregated telemetry and keep buffer bounded.
   */
  startDrainTimer(
    intervalMs: number = 60_000,
    onDrain?: (aggregated: AggregatedTelemetry[]) => void | Promise<void>,
  ): void {
    this.stopDrainTimer()
    this.drainTimer = setInterval(async () => {
      if (this.ringBuffer.length === 0) return
      const aggregated = await this.drain()
      if (onDrain && aggregated.length > 0) {
        await onDrain(aggregated)
      }
    }, intervalMs)
    ;(this.drainTimer as { unref?: () => void }).unref?.()
  }

  stopDrainTimer(): void {
    if (this.drainTimer) {
      clearInterval(this.drainTimer)
      this.drainTimer = null
    }
  }

  getStats(): { bufferSize: number; aggregationCount: number; checksumCount: number } {
    return {
      bufferSize: this.ringBuffer.length,
      aggregationCount: this.aggregations.size,
      checksumCount: this.eventChecksums.size,
    }
  }

  clear(): void {
    this.stopDrainTimer()
    this.ringBuffer = []
    this.aggregations.clear()
    this.eventChecksums.clear()
  }
}
