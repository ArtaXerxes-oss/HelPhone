/**
 * usePositionArbiter — fuses phone GPS, an optional Bluetooth NMEA puck and
 * a manual override into one position (#803). See lib/positionArbiter.ts.
 *
 * `pairPuck()` must be called from a user gesture (Web Bluetooth rule).
 * Puck disconnect drops the source immediately and sets `puckLost` so the
 * UI can show a reconnect affordance / play an alert.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { NmeaStream } from '../lib/nmeaParser'
import { PositionArbiter, type ArbitratedFix } from '../lib/positionArbiter'

// Nordic UART service: what most BLE NMEA pucks expose.
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e'
const NUS_TX_CHAR = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'

export interface PositionArbiterState {
  fix: ArbitratedFix | null
  puckConnected: boolean
  puckLost: boolean
  error: string | null
  pairPuck: () => Promise<void>
  setManual: (lat: number, lng: number) => void
  clearManual: () => void
}

export function usePositionArbiter({ enabled = true, tickMs = 100 } = {}): PositionArbiterState {
  const arbiterRef = useRef(new PositionArbiter())
  const deviceRef = useRef<any>(null)
  const [fix, setFix] = useState<ArbitratedFix | null>(null)
  const [puckConnected, setPuckConnected] = useState(false)
  const [puckLost, setPuckLost] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !navigator.geolocation) return
    const id = navigator.geolocation.watchPosition(
      (pos) =>
        arbiterRef.current.push({
          source: 'phone',
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          at: pos.timestamp || Date.now(),
        }),
      (err) => setError(err.message),
      { enableHighAccuracy: true, maximumAge: 5_000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [enabled])

  // Render loop for eased transitions; cheap, only sets state when moved.
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => {
      const next = arbiterRef.current.current()
      setFix((prev) =>
        prev && next && prev.lat === next.lat && prev.lng === next.lng && prev.stale === next.stale && prev.source === next.source
          ? prev
          : next,
      )
    }, tickMs)
    return () => clearInterval(timer)
  }, [enabled, tickMs])

  useEffect(() => () => deviceRef.current?.gatt?.disconnect?.(), [])

  const pairPuck = useCallback(async () => {
    const bluetooth = (navigator as any).bluetooth
    if (!bluetooth) {
      setError('bluetooth_unsupported')
      return
    }
    try {
      const device = await bluetooth.requestDevice({
        filters: [{ services: [NUS_SERVICE] }],
        optionalServices: [NUS_SERVICE],
      })
      deviceRef.current = device
      const server = await device.gatt.connect()
      const service = await server.getPrimaryService(NUS_SERVICE)
      const characteristic = await service.getCharacteristic(NUS_TX_CHAR)
      const stream = new NmeaStream()
      const decoder = new TextDecoder()
      let hdop: number | undefined
      characteristic.addEventListener('characteristicvaluechanged', (event: any) => {
        for (const nmea of stream.push(decoder.decode(event.target.value))) {
          if (nmea.hdop != null) hdop = nmea.hdop
          arbiterRef.current.push({
            source: 'puck',
            lat: nmea.lat,
            lng: nmea.lng,
            accuracy: nmea.accuracy ?? (hdop != null ? hdop * 5 : 10),
            hdop,
            at: Date.now(),
          })
        }
      })
      device.addEventListener('gattserverdisconnected', () => {
        arbiterRef.current.remove('puck')
        setPuckConnected(false)
        setPuckLost(true)
      })
      await characteristic.startNotifications()
      setPuckConnected(true)
      setPuckLost(false)
      setError(null)
    } catch (err) {
      setError(err instanceof Error && err.name === 'NotFoundError' ? 'puck_not_found' : 'puck_pair_failed')
    }
  }, [])

  const setManual = useCallback((lat: number, lng: number) => {
    arbiterRef.current.push({ source: 'manual', lat, lng, accuracy: 15, at: Date.now() })
  }, [])

  const clearManual = useCallback(() => arbiterRef.current.remove('manual'), [])

  return { fix, puckConnected, puckLost, error, pairPuck, setManual, clearManual }
}
