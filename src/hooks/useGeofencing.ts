/**
 * useGeofencing — enforces shelter-polygon containment for kiosk filings.
 *
 * Watches the browser's Geolocation API and compares the live position
 * against the shelter polygon loaded from geofence.ts. Returns whether
 * the current position is inside the polygon plus the last known position.
 */
import { useState, useEffect, useRef } from 'react'
import { isInsideShelterPolygon, getShelterPolygon, type ShelterPolygon } from '../lib/geofence'

export interface GeofencingState {
  /** null = not yet determined (no GPS fix yet) */
  insidePolygon: boolean | null
  lat: number | null
  lng: number | null
  /** GPS accuracy in metres, if available */
  accuracy: number | null
  error: string | null
  polygon: ShelterPolygon | null
}

export function useGeofencing(shelterId: string | null): GeofencingState {
  const [state, setState] = useState<GeofencingState>({
    insidePolygon: null,
    lat: null,
    lng: null,
    accuracy: null,
    error: null,
    polygon: null,
  })
  const watchIdRef = useRef<number | null>(null)

  useEffect(() => {
    if (!shelterId) return

    const polygon = getShelterPolygon(shelterId)
    setState((s) => ({ ...s, polygon }))

    if (!navigator.geolocation) {
      setState((s) => ({ ...s, error: 'Geolocation unavailable' }))
      return
    }

    function onPosition(pos: GeolocationPosition): void {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords
      const insidePolygon = polygon ? isInsideShelterPolygon(lat, lng, polygon) : null
      setState({ insidePolygon, lat, lng, accuracy, error: null, polygon })
    }

    function onError(err: GeolocationPositionError): void {
      setState((s) => ({ ...s, error: err.message }))
    }

    watchIdRef.current = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      maximumAge: 10_000,
    })

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current)
        watchIdRef.current = null
      }
    }
  }, [shelterId])

  return state
}
