import { useEffect, useState } from 'react'
import { dijkstra, loadRoadNetwork } from '../../lib/routing.ts'
import { KIOSK_ORIGIN_TAG } from '../../lib/wsClient.ts'
import type { RouteResult, SpatialGraph } from '../../types/index.ts'

export function useResponderRoute(source?: number, destination?: number) {
  const [graph, setGraph] = useState<SpatialGraph | null>(null)
  const [route, setRoute] = useState<RouteResult | null>(null)
  const [error, setError] = useState<Error | null>(null)
  useEffect(() => {
    let active = true
    loadRoadNetwork().then((value) => active && setGraph(value)).catch((reason) => active && setError(reason as Error))
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (graph && source !== undefined && destination !== undefined) {
      setRoute(dijkstra(graph, source, destination))
    }
  }, [graph, source, destination])
  return { route, loading: !graph && !error, error }
}

export default function ResponderTracker({
  source,
  destination,
  origin,
}: {
  source: number
  destination: number
  /** Pass KIOSK_ORIGIN_TAG when the intent originated from kiosk mode. */
  origin?: string
}) {
  const { route, loading, error } = useResponderRoute(source, destination)
  const isKiosk = origin === KIOSK_ORIGIN_TAG

  if (error) return <span role="alert">Route unavailable</span>
  if (loading) return <span>Calculating route…</span>
  return (
    <span>
      {route ? `${route.distanceKm.toFixed(1)} km away` : 'No road route found'}
      {isKiosk && (
        <span
          aria-label="Unverified kiosk intake — needs triage"
          style={{
            marginLeft: 8,
            padding: '2px 7px',
            borderRadius: 5,
            background: 'rgba(255,122,107,0.18)',
            border: '1px solid rgba(255,122,107,0.4)',
            color: '#FF7A6B',
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: '0.8px',
            verticalAlign: 'middle',
          }}
        >
          UNVERIFIED — needs triage
        </span>
      )}
    </span>
  )
}
