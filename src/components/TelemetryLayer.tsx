/** React adapter that registers the typed-array Mapbox custom layer. */

import { useEffect } from 'react'
import { useMap } from 'react-map-gl/mapbox'
import type { TelemetryBuffers } from '../lib/telemetryBuffers'
import { createTelemetryLayer } from '../lib/telemetryLayer'

export interface TelemetryLayerProps {
  buffers: TelemetryBuffers
  id?: string
}

export default function TelemetryLayer({ buffers, id = 'helphone-telemetry' }: TelemetryLayerProps) {
  const map = useMap().current

  useEffect(() => {
    if (!map) return
    const layer = createTelemetryLayer(buffers, id)
    const add = () => {
      try {
        if (!map.getLayer(id)) map.addLayer(layer)
      } catch {
        /* style not ready yet — the style.load handler retries */
      }
    }
    if (map.isStyleLoaded()) add()
    else map.once('style.load', add)

    return () => {
      try {
        map.off('style.load', add)
        if (map.getLayer(id)) map.removeLayer(id)
      } catch {
        /* map already torn down */
      }
    }
  }, [map, buffers, id])

  return null
}
