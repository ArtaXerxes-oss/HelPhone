import { forwardRef, useEffect, useRef, useState } from 'react'
import type { CSSProperties, MutableRefObject, ReactNode } from 'react'
import Map, { NavigationControl } from 'react-map-gl/mapbox'
import type { MapProps } from 'react-map-gl/mapbox'
import 'mapbox-gl/dist/mapbox-gl.css'
import { searchCities, isOffline } from '../lib/geocoder.ts'
import { loadRoadNetwork } from '../lib/routing.ts'
import { MapboxGLResourceManager } from '../lib/memoryLeakFixes.ts'
import { DEFAULT_LONG_TASK_THRESHOLDS, LongTaskMonitor } from '../lib/mainThreadOptimization.ts'
import TelemetryLayer from './TelemetryLayer'
import type { TelemetryBuffers } from '../lib/telemetryBuffers.ts'

/**
 * MapboxWrapper (#87)
 *
 * Encapsulates Mapbox / react-map-gl initialisation so pages don't have to
 * repeat the access-token wiring, the default view state and the standard
 * on-map controls. Everything specific to a screen — markers, sources,
 * layers, popups, controllers — is passed as `children` and rendered inside
 * the underlying `<Map>` exactly as before.
 *
 * The component forwards its ref to the react-map-gl `<Map>` instance, so
 * callers that need the imperative map handle (`ref.current.getMap()`) keep
 * working. On unmount the map is handed to the leak guard (#961).
 */

const DEFAULT_TOKEN = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_MAPBOX_TOKEN
const DEFAULT_VIEW_STATE = { longitude: 0, latitude: 20, zoom: 2 }
const FILL_PARENT: CSSProperties = { width: '100%', height: '100%' }

/** Any other react-map-gl `<Map>` prop passes straight through. */
type PassThroughMapProps = Omit<
  MapProps,
  'mapStyle' | 'onClick' | 'initialViewState' | 'mapboxAccessToken' | 'style' | 'children' | 'onLoad' | 'onError'
>

interface MapboxWrapperProps extends PassThroughMapProps {
  mapStyle: string
  onMapClick?: MapProps['onClick']
  initialViewState?: { longitude: number; latitude: number; zoom: number }
  accessToken?: string
  showNavigationControl?: boolean
  onIsolationChange?: (isolated: boolean) => void
  onProviderChange?: (provider: 'online' | 'offline') => void
  navigationControlPosition?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
  /** Optional preallocated telemetry store; adds the binary custom layer. */
  telemetryBuffers?: TelemetryBuffers
  style?: CSSProperties
  /** Map content, or a render function that receives the offline geocoder while offline. */
  children?: ReactNode | ((ctx: { provider: 'online' | 'offline'; searchCities: typeof searchCities }) => ReactNode)
}

const MapboxWrapper = forwardRef<unknown, MapboxWrapperProps>(function MapboxWrapper(
  {
    mapStyle,
    onMapClick,
    initialViewState,
    accessToken,
    showNavigationControl = true,
    navigationControlPosition = 'bottom-right',
    onIsolationChange,
    onProviderChange,
    telemetryBuffers,
    style = FILL_PARENT,
    children,
    ...rest
  },
  ref,
) {
  const internalRef = useRef<{ getMap?: () => unknown } | null>(null)
  const [provider, setProvider] = useState<'online' | 'offline'>('online')
  const providerRef = useRef(provider)
  providerRef.current = provider

  // #518: fall back to the offline geocoder when Mapbox can't serve tiles —
  // detect via navigator.onLine and notify callers so they swap the search
  // suggestions source. (`onMapError` on `<Map>` also flips the flag if the
  // tile/style request itself fails while the network looks fine.)
  useEffect(() => {
    const update = () => {
      const next = isOffline() || !(accessToken ?? DEFAULT_TOKEN) ? 'offline' : 'online'
      if (next !== providerRef.current) {
        setProvider(next)
      }
    }
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [accessToken])

  useEffect(() => {
    if (typeof onProviderChange === 'function') onProviderChange(provider)
  }, [provider, onProviderChange])

  useEffect(() => {
    const resourceMgr = new MapboxGLResourceManager()
    const monitor = new LongTaskMonitor(DEFAULT_LONG_TASK_THRESHOLDS, { route: '/map' })
    monitor.startMonitoring()
    const id = window.setTimeout(() => { void loadRoadNetwork().catch(() => undefined) }, 0)
    return () => {
      window.clearTimeout(id)
      monitor.stopMonitoring()
      // #961: release the map's listeners and GPU resources with the manager.
      if (internalRef.current?.getMap) {
        try {
          const mapInstance = internalRef.current.getMap()
          if (mapInstance) resourceMgr.setMap(mapInstance as Parameters<typeof resourceMgr.setMap>[0])
        } catch {
          // Map already removed or disposed
        }
      }
      resourceMgr.dispose()
    }
  }, [])

  return (
    <Map
      ref={(mapInstance: { getMap?: () => unknown } | null) => {
        internalRef.current = mapInstance
        if (typeof ref === 'function') ref(mapInstance)
        else if (ref) (ref as MutableRefObject<unknown>).current = mapInstance
      }}
      mapboxAccessToken={accessToken ?? DEFAULT_TOKEN}
      initialViewState={initialViewState ?? DEFAULT_VIEW_STATE}
      style={style}
      onLoad={() => onIsolationChange?.(globalThis.crossOriginIsolated === true)}
      mapStyle={mapStyle}
      onClick={onMapClick}
      onError={() => {
        if (providerRef.current !== 'offline') setProvider('offline')
      }}
      {...rest}
    >
      {showNavigationControl && (
        <NavigationControl position={navigationControlPosition} />
      )}
      {telemetryBuffers && <TelemetryLayer buffers={telemetryBuffers} />}
      {provider === 'offline' && typeof children === 'function'
        ? (children as (ctx: { provider: 'online' | 'offline'; searchCities: typeof searchCities }) => ReactNode)({ provider, searchCities })
        : children}
    </Map>
  )
})

export default MapboxWrapper
