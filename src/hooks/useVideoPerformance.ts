/**
 * Video performance optimization hook (Issue #745)
 * Addresses FCP/LCP regression from hero-nokia.mp4 forward/reverse RAF loop
 */

import { useEffect, useRef } from 'react'
import { trackVideoPerformance } from '../lib/telemetry'

interface VideoPerformanceConfig {
  throttleMs?: number  // RAF throttle interval (default 16ms ~60fps)
  enableMetrics?: boolean
  onFrameDrop?: () => void
}

export function useVideoPerformance(config: VideoPerformanceConfig = {}) {
  const {
    throttleMs = 16, // ~60fps
    enableMetrics = true,
    onFrameDrop,
  } = config

  const rafIdRef = useRef<number>()
  const lastFrameTimeRef = useRef<number>(0)
  const frameDropCountRef = useRef<number>(0)

  const throttledRequestAnimationFrame = (callback: FrameRequestCallback): number => {
    return requestAnimationFrame((timestamp) => {
      const timeSinceLastFrame = timestamp - lastFrameTimeRef.current

      if (timeSinceLastFrame >= throttleMs) {
        lastFrameTimeRef.current = timestamp
        callback(timestamp)
      } else {
        // Frame dropped - schedule for next window
        frameDropCountRef.current++
        if (enableMetrics && frameDropCountRef.current % 30 === 0) {
          trackVideoPerformance('frame_drop', frameDropCountRef.current)
          if (onFrameDrop) {
            onFrameDrop()
          }
        }
        rafIdRef.current = throttledRequestAnimationFrame(callback)
      }
    })
  }

  useEffect(() => {
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
      }
    }
  }, [])

  return {
    throttledRAF: throttledRequestAnimationFrame,
    frameDropCount: frameDropCountRef.current,
    reset: () => {
      frameDropCountRef.current = 0
      lastFrameTimeRef.current = 0
    },
  }
}

/**
 * Video element optimization with poster image and resource hints
 * Prevents LCP regression from hero video
 */
export function optimizeVideoElement(
  videoRef: React.RefObject<HTMLVideoElement>,
  options: {
    preloadPoster?: boolean
    enableLazyLoad?: boolean
  } = {}
) {
  const { preloadPoster = true, enableLazyLoad = true } = options

  useEffect(() => {
    if (!videoRef.current) return

    const video = videoRef.current

    // Preload poster image to improve LCP
    if (preloadPoster && video.poster) {
      const img = new Image()
      img.src = video.poster
    }

    // Add loading attribute for lazy loading
    if (enableLazyLoad) {
      video.setAttribute('loading', 'lazy')
    }

    // Optimize codec hints
    const sourceElements = video.querySelectorAll('source')
    sourceElements.forEach((source) => {
      if (!source.hasAttribute('type')) {
        const src = source.src
        if (src.endsWith('.webm')) {
          source.type = 'video/webm'
        } else if (src.endsWith('.mp4')) {
          source.type = 'video/mp4'
        }
      }
    })

    // Prevent autoplay on slow connections
    if (!navigator.connection || (navigator.connection as any).saveData) {
      video.autoplay = false
    }
  }, [videoRef])
}
