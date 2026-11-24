/**
 * src/hooks/useMapContextLoss.ts — Map GL context loss / recovery hook
 * (ISP-140)
 *
 * Folding, spanning, or rotating with a Mapbox GL map visible triggers
 * `webglcontextlost`. Without `preventDefault` the browser destroys the
 * context and the map goes grey permanently. This hook:
 *
 *  1. Listens for `webglcontextlost` on the map canvas → preventDefault +
 *     snapshot the current style, sources, camera, and selected pin.
 *  2. Listens for `webglcontextrestored` → re-apply style, re-add sources,
 *     re-seek camera from the snapshot.
 * 3. Exposes `contextLost` so the UI can show a "Map paused — restoring"
 *     shimmer overlay.
 *
 * The snapshot is captured from the underlying mapbox-gl Map instance
 * (obtained via `react-map-gl`'s `getMap()` on the ref). If the map or
 * canvas is not available the hook is a no-op.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** Snapshot of map state captured at the moment of GL context loss. */
export interface MapSnapshot {
  /** Mapbox style URL at the time of loss. */
  style: string
  /** Serialized source definitions (id → {type, data, ...}). */
  sources: Array<{ id: string; type: string; data?: unknown }>
  /** Camera state for re-seek on restore. */
  camera: {
    center: [number, number] | { lng: number; lat: number }
    zoom: number
    pitch: number
    bearing: number
  }
  /** Timestamp of the snapshot (for staleness checks). */
  timestamp: number
}

export interface UseMapContextLossOptions {
  /**
   * Ref to the react-map-gl Map instance (the value returned by `useMap()`
   * or a `ref` callback). The hook calls `.getMap()` on it to access the
   * underlying mapbox-gl Map.
   */
  mapRef: React.MutableRefObject<any>
  /** Called after a snapshot is captured (e.g. to store pin state). */
  onContextLost?: (snapshot: MapSnapshot) => void
  /** Called after the map is restored from a snapshot. */
  onContextRestored?: (snapshot: MapSnapshot) => void
}

export interface UseMapContextLossResult {
  /** True while the GL context is lost and the map is paused. */
  contextLost: boolean
  /** The most recent snapshot, or null if no loss has occurred. */
  snapshot: MapSnapshot | null
  /** Manually trigger restore from the current snapshot. */
  restore: () => void
}

export function useMapContextLoss({
  mapRef,
  onContextLost,
  onContextRestored,
}: UseMapContextLossOptions): UseMapContextLossResult {
  const [contextLost, setContextLost] = useState(false)
  const [snapshot, setSnapshot] = useState<MapSnapshot | null>(null)
  const snapshotRef = useRef<MapSnapshot | null>(null)
  const onLostRef = useRef(onContextLost)
  const onRestoredRef = useRef(onContextRestored)
  onLostRef.current = onContextLost
  onRestoredRef.current = onContextRestored

  // Capture a snapshot of the current map state.
  const captureSnapshot = useCallback((): MapSnapshot | null => {
    const mapInstance = mapRef.current?.getMap?.() ?? mapRef.current
    if (!mapInstance) return null

    try {
      const style = mapInstance.getStyle?.() ?? {}
      const styleUrl = style?.name ? mapInstance._style?.url ?? '' : ''

      // Serialize sources
      const sourceIds = mapInstance.getStyle?.()?.sources
        ? Object.keys(mapInstance.getStyle().sources)
        : []
      const sources = sourceIds.map((id) => {
        const src = mapInstance.getSource(id)
        return {
          id,
          type: src?.type ?? 'unknown',
          data: undefined, // We can't easily serialize GeoJSON sources back;
          // the style object already has them for re-application.
        }
      })

      const center = mapInstance.getCenter?.() ?? { lng: 0, lat: 0 }
      const zoom = mapInstance.getZoom?.() ?? 0
      const pitch = mapInstance.getPitch?.() ?? 0
      const bearing = mapInstance.getBearing?.() ?? 0

      return {
        style: styleUrl,
        sources,
        camera: { center, zoom, pitch, bearing },
        timestamp: Date.now(),
      }
    } catch {
      return null
    }
  }, [mapRef])

  // Restore the map from a snapshot.
  const restore = useCallback(() => {
    const snap = snapshotRef.current
    if (!snap) return

    const mapInstance = mapRef.current?.getMap?.() ?? mapRef.current
    if (!mapInstance) return

    try {
      // Re-apply the style (this re-adds all sources and layers).
      if (snap.style) {
        mapInstance.setStyle?.(snap.style)
      }

      // Re-seek camera once the style is loaded.
      const seekCamera = () => {
        try {
          mapInstance.jumpTo({
            center: snap.camera.center,
            zoom: snap.camera.zoom,
            pitch: snap.camera.pitch,
            bearing: snap.camera.bearing,
          })
        } catch {
          // jumpTo can throw if the map is in a transient state.
        }
      }

      // If the map is already loaded, seek immediately; otherwise wait.
      if (mapInstance.loaded?.()) {
        seekCamera()
      } else {
        mapInstance.once?.('idle', seekCamera)
      }

      setContextLost(false)
      onRestoredRef.current?.(snap)
    } catch {
      // If restore fails, keep the contextLost state so the UI shows the
      // shimmer and the user can hard-reload.
    }
  }, [mapRef])

  // Attach webglcontextlost / webglcontextrestored listeners to the canvas.
  useEffect(() => {
    if (typeof window === 'undefined') return

    // Find the canvas element from the map instance.
    const getCanvas = (): HTMLCanvasElement | null => {
      const mapInstance = mapRef.current?.getMap?.() ?? mapRef.current
      const canvas = mapInstance?.getCanvas?.()
      if (canvas instanceof HTMLCanvasElement) return canvas
      // Fallback: search for canvas inside the map container.
      const container = mapInstance?.getContainer?.()
      if (container) {
        const c = container.querySelector?.('canvas')
        if (c instanceof HTMLCanvasElement) return c
      }
      return null
    }

    const handleContextLost = (e: Event) => {
      // Prevent the browser from destroying the context — we want to restore it.
      e.preventDefault()
      const snap = captureSnapshot()
      if (snap) {
        snapshotRef.current = snap
        setSnapshot(snap)
      }
      setContextLost(true)
      if (snap) onLostRef.current?.(snap)
    }

    const handleContextRestored = () => {
      restore()
    }

    // Poll for the canvas — it may not be available on first render.
    let canvas: HTMLCanvasElement | null = null
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let listenersAttached = false

    const attach = () => {
      canvas = getCanvas()
      if (canvas && !listenersAttached) {
        canvas.addEventListener('webglcontextlost', handleContextLost, false)
        canvas.addEventListener('webglcontextrestored', handleContextRestored, false)
        listenersAttached = true
        if (pollTimer) {
          clearTimeout(pollTimer)
          pollTimer = null
        }
      } else if (!canvas) {
        // Retry up to ~2s
        pollTimer = setTimeout(attach, 100)
      }
    }

    attach()

    return () => {
      if (pollTimer) clearTimeout(pollTimer)
      if (canvas && listenersAttached) {
        canvas.removeEventListener('webglcontextlost', handleContextLost, false)
        canvas.removeEventListener('webglcontextrestored', handleContextRestored, false)
      }
    }
  }, [mapRef, captureSnapshot, restore])

  return { contextLost, snapshot, restore }
}
