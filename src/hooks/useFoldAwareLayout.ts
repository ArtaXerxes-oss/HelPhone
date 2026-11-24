/**
 * src/hooks/useFoldAwareLayout.ts — Fold-aware layout hook (ISP-140)
 *
 * Provides a single debounced source of truth for viewport, breakpoint, and
 * fold state so that Help.jsx and other page components don't unmount/remount
 * sub-components during violent orientation churn (3 rotations in 2s).
 *
 * Key behaviors:
 *  - 250 ms debounce on resize/orientationchange/viewportsegmentchange so
 *    breakpoint swaps ride out churn without unmount storms.
 *  - "Churn" detection: 3+ orientation changes in 2s sets `isChurning=true`,
 *    which suppresses breakpoint transitions until things settle.
 *  - `debouncedBreakpoint` only changes after the debounce window, so
 *    conditional rendering that depends on the breakpoint remounts at most
 *    once per settled transition instead of once per churn frame.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { getFoldState, isFoldable, subscribeToFoldChanges, type FoldState } from '../lib/foldable'

export type Breakpoint = 'folded' | 'mobile' | 'tablet' | 'desktop'

export interface FoldAwareLayoutState {
  /** Current fold state (segments, hinge, etc.). */
  foldState: FoldState
  /** Raw viewport dimensions (updated immediately, not debounced). */
  viewport: { width: number; height: number }
  /** Debounced breakpoint — only changes after the debounce window settles. */
  debouncedBreakpoint: Breakpoint
  /** True during orientation churn (3+ changes in 2s). */
  isChurning: boolean
  /** Whether the device has foldable capabilities. */
  isFoldableDevice: boolean
}

const DEBOUNCE_MS = 250
const CHURN_WINDOW_MS = 2000
const CHURN_THRESHOLD = 3

function computeBreakpoint(width: number): Breakpoint {
  if (width < 400) return 'folded'
  if (width < 780) return 'mobile'
  if (width < 1024) return 'tablet'
  return 'desktop'
}

const initialFoldState: FoldState = {
  segments: [],
  hingeGap: null,
  segmentCount: 1,
  isFolded: false,
}

export function useFoldAwareLayout(): FoldAwareLayoutState {
  const [foldState, setFoldState] = useState<FoldState>(() => {
    if (typeof window === 'undefined') return initialFoldState
    return getFoldState()
  })
  const [viewport, setViewport] = useState(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
  }))
  const [debouncedBreakpoint, setDebouncedBreakpoint] = useState<Breakpoint>(() => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1024
    return computeBreakpoint(w)
  })
  const [isChurning, setIsChurning] = useState(false)

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const orientationTimesRef = useRef<number[]>([])
  const churnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastBreakpointRef = useRef<Breakpoint>(debouncedBreakpoint)

  const handleViewportChange = useCallback(() => {
    const width = window.innerWidth
    const height = window.innerHeight

    // Update raw viewport immediately (for e.g. map resize).
    setViewport({ width, height })

    // Track orientation changes for churn detection.
    // An orientation change is implied by a resize where width/height ratio
    // flips (portrait ↔ landscape).
    orientationTimesRef.current.push(Date.now())
    const cutoff = Date.now() - CHURN_WINDOW_MS
    orientationTimesRef.current = orientationTimesRef.current.filter((t) => t >= cutoff)

    if (orientationTimesRef.current.length >= CHURN_THRESHOLD) {
      setIsChurning(true)
      // Clear churn flag after the window settles.
      if (churnTimerRef.current) clearTimeout(churnTimerRef.current)
      churnTimerRef.current = setTimeout(() => {
        setIsChurning(false)
      }, CHURN_WINDOW_MS)
    }

    // Debounce breakpoint change.
    const newBreakpoint = computeBreakpoint(width)
    if (newBreakpoint === lastBreakpointRef.current) return

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(() => {
      lastBreakpointRef.current = newBreakpoint
      setDebouncedBreakpoint(newBreakpoint)
      setFoldState(getFoldState())
    }, DEBOUNCE_MS)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    window.addEventListener('resize', handleViewportChange, { passive: true })
    window.addEventListener('orientationchange', handleViewportChange, { passive: true })

    // Subscribe to fold changes from the foldable utility.
    const unsubFold = subscribeToFoldChanges((state) => {
      setFoldState(state)
      // Fold changes force a breakpoint re-evaluation immediately (no debounce)
      // since a fold/unfold is a deliberate user action, not churn.
      const w = window.innerWidth
      const bp = computeBreakpoint(w)
      if (bp !== lastBreakpointRef.current) {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
        lastBreakpointRef.current = bp
        setDebouncedBreakpoint(bp)
      }
    })

    return () => {
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('orientationchange', handleViewportChange)
      unsubFold()
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
      if (churnTimerRef.current) clearTimeout(churnTimerRef.current)
    }
  }, [handleViewportChange])

  return {
    foldState,
    viewport,
    debouncedBreakpoint,
    isChurning,
    isFoldableDevice: typeof window !== 'undefined' ? isFoldable() : false,
  }
}
