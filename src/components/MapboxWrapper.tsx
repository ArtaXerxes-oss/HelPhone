import { forwardRef } from 'react'
import Map, { NavigationControl } from 'react-map-gl/mapbox'
import 'mapbox-gl/dist/mapbox-gl.css'

/**
 * MapboxWrapper (#87)
 *
 * Encapsulates Mapbox / react-map-gl initialisation so pages don't have to
 * repeat the access-token wiring, the default view state and the standard
 * on-map controls. Everything specific to a screen — markers, sources,
 * layers, popups, controllers — is passed as `children` and rendered inside
 * the underlying `<Map>` exactly as before.
 */

const DEFAULT_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN
const DEFAULT_VIEW_STATE = { longitude: 0, latitude: 20, zoom: 2 }
const FILL_PARENT: React.CSSProperties = { width: '100%', height: '100%' }

interface MapboxWrapperProps {
  mapStyle: string
  onMapClick?: (e: unknown) => void
  initialViewState?: { longitude: number; latitude: number; zoom: number }
  accessToken?: string
  showNavigationControl?: boolean
  onIsolationChange?: (isolated: boolean) => void
  navigationControlPosition?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
  style?: React.CSSProperties
  children?: React.ReactNode
  [key: string]: unknown
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
    style = FILL_PARENT,
    children,
    ...rest
  },
  ref,
) {
  return (
    <Map
      // @ts-expect-error ref forwarding for react-map-gl
      ref={ref}
      mapboxAccessToken={accessToken ?? DEFAULT_TOKEN}
      initialViewState={initialViewState ?? DEFAULT_VIEW_STATE}
      style={style}
      onLoad={() => onIsolationChange?.(globalThis.crossOriginIsolated === true)}
      mapStyle={mapStyle}
      onClick={onMapClick}
      {...rest}
    >
      {showNavigationControl && (
        <NavigationControl position={navigationControlPosition} />
      )}
      {children}
    </Map>
  )
})

export default MapboxWrapper
