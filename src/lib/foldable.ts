/**
 * src/lib/foldable.ts — Foldable / dual-screen utilities (ISP-140)
 *
 * Provides a lightweight abstraction over the draft-spec Window Segments API
 * (`navigator.windowSegments`) and the CSS `screen-fold` media feature so the
 * rest of the app can reason about hinges, spans, and fold state without
 * every call site repeating the feature-detection dance.
 *
 * All functions are SSR-safe: they return sensible candybar defaults when
 * `window` or `navigator` is unavailable or when the APIs are absent.
 */

/** Physical layout state of the device's display surface(s). */
export interface FoldState {
  /** One DOMRect per display segment. On a candybar phone this is a single
   *  rect equal to the viewport. On a dual-screen span it is two rects. */
  segments: DOMRect[]
  /** The gap between segments (hinge area), or null on single-screen. */
  hingeGap: DOMRect | null
  /** Number of distinct display segments (1 = candybar, 2 = dual-screen). */
  segmentCount: number
  /** True when the device is in a folded configuration (narrow span). */
  isFolded: boolean
}

/** Custom event dispatched when a fold/unfold/span transition is detected. */
export const FOLD_CHANGE_EVENT = 'helphone:foldchange'

/** Hinge exclusion zone — no interactive target should live within 24px. */
export const HINGE_EXCLUSION_PX = 24

/** Viewport delta (px) that qualifies as a fold/unfold transition. */
export const FOLD_DELTA_THRESHOLD = 400

/* ── Window Segments polyfill ─────────────────────────────────────── */

/**
 * Return an array of DOMRects representing each display segment.
 * Falls back to a single rect (the viewport) when the API is unavailable.
 */
export function getWindowSegments(): DOMRect[] {
  if (typeof window === 'undefined') return []

  // Draft spec: navigator.windowSegments (Samsung/MS dual-screen proposal)
  const nav = navigator as Navigator & { windowSegments?: () => DOMRect[] }
  if (typeof nav.windowSegments === 'function') {
    try {
      const segs = nav.windowSegments()
      if (segs && segs.length > 0) return segs
    } catch {
      // fall through
    }
  }

  // viewport-segment media queries (another draft approach)
  if (typeof window.matchMedia === 'function') {
    try {
      const mql = window.matchMedia('(viewport-segments: 2)')
      if (mql.matches) {
        // We know there are 2 segments but can't get exact rects without the
        // JS API — approximate by splitting the viewport in half horizontally.
        const vw = window.innerWidth
        const vh = window.innerHeight
        // Assume left-right split for landscape, top-bottom for portrait.
        if (vw > vh) {
          return [
            new DOMRect(0, 0, vw / 2, vh),
            new DOMRect(vw / 2, 0, vw / 2, vh),
          ]
        }
        return [
          new DOMRect(0, 0, vw, vh / 2),
          new DOMRect(0, vh / 2, vw, vh / 2),
        ]
      }
    } catch {
      // matchMedia not supported
    }
  }

  // Candybar fallback: single segment = the viewport
  if (typeof window.innerWidth === 'number') {
    return [new DOMRect(0, 0, window.innerWidth, window.innerHeight)]
  }

  return []
}

/* ── Fold detection ──────────────────────────────────────────────── */

/**
 * Whether the device has foldable capabilities — either the Window Segments
 * API, the `screen-fold` CSS media feature, or both.
 */
export function isFoldable(): boolean {
  if (typeof navigator !== 'undefined') {
    const nav = navigator as Navigator & { windowSegments?: () => DOMRect[] }
    if (typeof nav.windowSegments === 'function') return true
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      // The `screen-fold` media feature is draft-spec but Chrome on Android
      // exposes it on some Samsung devices.
      if (window.matchMedia('(screen-fold)').matches) return true
      if (window.matchMedia('(viewport-segments: 2)').matches) return true
    } catch {
      // not supported
    }
  }
  return false
}

/** Number of distinct display segments (1 on candybar, 2 on dual-screen). */
export function getSegmentCount(): number {
  return getWindowSegments().length
}

/**
 * Compute the hinge gap rect between two segments, or null on single-screen.
 * The gap is the space between the right edge of the left segment and the
 * left edge of the right segment (horizontal hinge), or vertically for
 * portrait hinges.
 */
export function getHingeGap(): DOMRect | null {
  const segments = getWindowSegments()
  if (segments.length < 2) return null

  // Sort by position — left-to-right or top-to-bottom
  const sorted = [...segments].sort((a, b) => {
    if (a.left !== b.left) return a.left - b.left
    return a.top - b.top
  })

  const first = sorted[0]
  const second = sorted[1]

  // Horizontal hinge (left-right segments)
  if (second.left >= first.right) {
    const gapWidth = second.left - first.right
    if (gapWidth > 0) {
      return new DOMRect(first.right, 0, gapWidth, Math.max(first.height, second.height))
    }
    // Segments are adjacent — hinge has zero width but still exists
    return new DOMRect(first.right - HINGE_EXCLUSION_PX, 0, HINGE_EXCLUSION_PX * 2, Math.max(first.height, second.height))
  }

  // Vertical hinge (top-bottom segments)
  if (second.top >= first.bottom) {
    const gapHeight = second.top - first.bottom
    if (gapHeight > 0) {
      return new DOMRect(0, first.bottom, Math.max(first.width, second.width), gapHeight)
    }
    return new DOMRect(0, first.bottom - HINGE_EXCLUSION_PX, Math.max(first.width, second.width), HINGE_EXCLUSION_PX * 2)
  }

  return null
}

/**
 * Check whether a point (x, y) falls within the hinge exclusion zone.
 * The exclusion zone extends HINGE_EXCLUSION_PX beyond the hinge rect on
 * each side so interactive targets avoid the fold seam.
 */
export function isHingeArea(x: number, y: number): boolean {
  const gap = getHingeGap()
  if (!gap) return false

  return (
    x >= gap.left - HINGE_EXCLUSION_PX &&
    x <= gap.right + HINGE_EXCLUSION_PX &&
    y >= gap.top - HINGE_EXCLUSION_PX &&
    y <= gap.bottom + HINGE_EXCLUSION_PX
  )
}

/**
 * Check whether a DOMRect intersects the hinge exclusion zone.
 * Used to verify no interactive target is occluded by the hinge.
 */
export function intersectsHinge(rect: DOMRect): boolean {
  const gap = getHingeGap()
  if (!gap) return false

  const expanded = new DOMRect(
    gap.left - HINGE_EXCLUSION_PX,
    gap.top - HINGE_EXCLUSION_PX,
    gap.width + HINGE_EXCLUSION_PX * 2,
    gap.height + HINGE_EXCLUSION_PX * 2,
  )

  return (
    rect.left < expanded.right &&
    rect.right > expanded.left &&
    rect.top < expanded.bottom &&
    rect.bottom > expanded.top
  )
}

/* ── Full fold state ─────────────────────────────────────────────── */

/**
 * Build the complete FoldState from current window/navigator state.
 * Call this on resize, orientationchange, or viewportsegmentchange.
 */
export function getFoldState(): FoldState {
  const segments = getWindowSegments()
  const hingeGap = getHingeGap()
  const segmentCount = segments.length

  // "Folded" means the viewport is narrow enough to be a single folded panel.
  // On a Z Fold 5 the folded width is ~344px; on a Pixel Fold ~412px.
  // We treat anything under 480px with foldable capability as folded.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 0
  const isFolded = segmentCount === 1 && isFoldable() && vw < 480

  return { segments, hingeGap, segmentCount, isFolded }
}

/* ── Fold-intent signal ──────────────────────────────────────────── */

/**
 * Subscribe to fold-intent events. Fires on large viewport changes
 * (> FOLD_DELTA_THRESHOLD px delta in width) that indicate a fold/unfold
 * transition, as well as orientation changes.
 *
 * Returns an unsubscribe function.
 *
 * @param handler Called with the new FoldState and the previous viewport width.
 */
export function subscribeToFoldChanges(
  handler: (state: FoldState, prevWidth: number) => void,
): () => void {
  if (typeof window === 'undefined') return () => {}

  let lastWidth = window.innerWidth
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const onChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      const currentWidth = window.innerWidth
      const delta = Math.abs(currentWidth - lastWidth)
      // Only fire for large deltas (fold/unfold) or orientation changes.
      // Small resizes (e.g. desktop window drag) are ignored unless on a
      // foldable device.
      if (delta > FOLD_DELTA_THRESHOLD || isFoldable()) {
        const state = getFoldState()
        handler(state, lastWidth)
        lastWidth = currentWidth
      } else {
        lastWidth = currentWidth
      }
    }, 150)
  }

  window.addEventListener('resize', onChange)
  window.addEventListener('orientationchange', onChange)

  // viewport-segment media query listener (Chrome dual-screen)
  let mql: MediaQueryList | null = null
  if (typeof window.matchMedia === 'function') {
    try {
      mql = window.matchMedia('(viewport-segments: 2)')
      // addEventListener is the modern API; addListener is the Safari fallback
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', onChange)
      } else if (typeof (mql as any).addListener === 'function') {
        ;(mql as any).addListener(onChange)
      }
    } catch {
      // not supported
    }
  }

  return () => {
    window.removeEventListener('resize', onChange)
    window.removeEventListener('orientationchange', onChange)
    if (mql) {
      if (typeof mql.removeEventListener === 'function') {
        mql.removeEventListener('change', onChange)
      } else if (typeof (mql as any).removeListener === 'function') {
        ;(mql as any).removeListener(onChange)
      }
    }
    if (debounceTimer) clearTimeout(debounceTimer)
  }
}

/**
 * Dispatch a FOLD_CHANGE_EVENT on the window so any listener (including
 * those outside React) can react to fold transitions.
 */
export function dispatchFoldChange(state: FoldState): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  window.dispatchEvent(new CustomEvent(FOLD_CHANGE_EVENT, { detail: state }))
}
