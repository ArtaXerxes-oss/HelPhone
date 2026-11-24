/**
 * foldableScreen — detects foldable / dual-screen viewport state.
 *
 * Foldable devices (Samsung Galaxy Z Fold, Microsoft Surface Duo, …) expose
 * a viewport segment API and CSS environment variables (`env(viewport-segment-*)`)
 * that describe the hinge gap. This module wraps those primitives behind a
 * stable, SSR-safe API so the rest of the app never touches `window` directly.
 *
 * Every public function guards against a non-browser environment: on the
 * server (or in a worker without DOM access) it returns a safe default and
 * never throws.
 */

/** A single segment edge reported by the viewport segments API. */
export interface ViewportSegment {
  /** 0-based index — `0` is the leftmost / topmost segment. */
  index: number
  /** Pixel offset from the viewport origin (top-left). */
  start: number
  /** Pixel extent of the segment. */
  span: number
}

/** Orientation reported by `window.screen.orientation` (SSR-safe). */
export type ScreenOrientation =
  | 'portrait'
  | 'landscape'
  | 'unknown'

/** A snapshot of the foldable viewport state. */
export interface FoldableState {
  /** True when the viewport segments API is available (a foldable device). */
  isFoldable: boolean
  /** Number of viewport segments (1 on a flat screen, 2 on a dual-screen). */
  segmentCount: number
  /** Segment descriptors, ordered left→right / top→bottom. */
  segments: ViewportSegment[]
  /** Width of the hinge gap in CSS pixels (0 when there is no hinge). */
  hingeWidth: number
  /** Current screen orientation. */
  orientation: ScreenOrientation
  /** Viewport width in CSS pixels. */
  width: number
  /** Viewport height in CSS pixels. */
  height: number
}

/** The safe default returned when running outside a browser. */
export const DEFAULT_FOLDABLE_STATE: FoldableState = {
  isFoldable: false,
  segmentCount: 1,
  segments: [],
  hingeWidth: 0,
  orientation: 'unknown',
  width: 0,
  height: 0,
}

/**
 * Returns true when the current environment has a DOM `window`.
 * SSR-safe guard used by every public function in this module.
 */
export function hasWindow(): boolean {
  return typeof window !== 'undefined'
}

/**
 * Detects the current screen orientation from `window.screen.orientation`.
 * SSR-safe: returns `'unknown'` outside the browser.
 */
export function getOrientation(): ScreenOrientation {
  if (!hasWindow()) return 'unknown'
  const orientation =
    window.screen?.orientation?.type ?? (window.screen as any)?.mozOrientation
  if (typeof orientation !== 'string') return 'unknown'
  if (orientation.startsWith('portrait')) return 'portrait'
  if (orientation.startsWith('landscape')) return 'landscape'
  return 'unknown'
}

/**
 * Reads the viewport segments from the browser's experimental API.
 *
 * Browsers expose `window.visualViewport.segments` (Chrome/Edge) or a
 * `window.screen.segments` polyfill. Each entry is an `AVRect` with
 * `{ x, y, width, height, top, left, right, bottom }`.
 *
 * SSR-safe: returns an empty array outside the browser.
 */
export function getViewportSegments(): ViewportSegment[] {
  if (!hasWindow()) return []

  const raw =
    (window.visualViewport as any)?.segments ??
    (window.screen as any)?.segments ??
    null

  if (!Array.isArray(raw) || raw.length === 0) return []

  return raw.map((rect: any, index: number): ViewportSegment => {
    const start = typeof rect.x === 'number' ? rect.x : rect.left ?? 0
    const span = typeof rect.width === 'number' ? rect.width : 0
    return { index, start, span }
  })
}

/**
 * Computes the hinge (fold gap) width in CSS pixels.
 *
 * On a single-screen device there is no hinge, so this returns 0. On a
 * dual-screen device the hinge is the gap between the last pixel of the
 * first segment and the first pixel of the second segment.
 *
 * SSR-safe: returns 0 outside the browser.
 */
export function getHingeWidth(segments: ViewportSegment[]): number {
  if (!hasWindow()) return 0
  if (segments.length < 2) return 0

  const [first, second] = segments
  const orientation = getOrientation()

  if (orientation === 'portrait') {
    // Hinge runs horizontally — gap is between the bottom of the top segment
    // and the top of the bottom segment.
    const firstBottom = first.start + first.span
    return Math.max(0, second.start - firstBottom)
  }

  // Landscape (or unknown) — hinge runs vertically.
  const firstRight = first.start + first.span
  return Math.max(0, second.start - firstRight)
}

/**
 * Captures a complete foldable viewport snapshot.
 *
 * This is the single entry point callers should use. It is SSR-safe: outside
 * a browser it returns `DEFAULT_FOLDABLE_STATE`.
 */
export function getFoldableState(): FoldableState {
  if (!hasWindow()) return DEFAULT_FOLDABLE_STATE

  const segments = getViewportSegments()
  const isFoldable = segments.length >= 2

  return {
    isFoldable,
    segmentCount: segments.length || 1,
    segments,
    hingeWidth: getHingeWidth(segments),
    orientation: getOrientation(),
    width: window.innerWidth,
    height: window.innerHeight,
  }
}

/**
 * Resolves the content-spanning mode for a given foldable state.
 *
 * - `'single'`  — one screen; content spans the full viewport.
 * - `'dual'`    — two screens with a hinge; content should avoid the hinge.
 * - `'spanned'` — app is spanning the hinge; content should be split.
 *
 * SSR-safe: returns `'single'` outside the browser.
 */
export function getSpanningMode(
  state: FoldableState = getFoldableState(),
): 'single' | 'dual' | 'spanned' {
  if (!hasWindow()) return 'single'
  if (!state.isFoldable) return 'single'
  // When the app window crosses the hinge we treat it as spanned.
  if (state.hingeWidth > 0 && state.segmentCount >= 2) return 'spanned'
  return 'dual'
}

/**
 * Returns the safe content insets (padding) so interactive elements do not
 * land on the hinge. The insets are in CSS pixels keyed by edge.
 *
 * SSR-safe: returns all-zero insets outside the browser.
 */
export function getHingeInsets(
  state: FoldableState = getFoldableState(),
): { top: number; right: number; bottom: number; left: number } {
  if (!hasWindow()) return { top: 0, right: 0, bottom: 0, left: 0 }
  if (!state.isFoldable || state.hingeWidth <= 0) {
    return { top: 0, right: 0, bottom: 0, left: 0 }
  }

  const orientation = state.orientation
  const gap = state.hingeWidth

  // In portrait the hinge is horizontal → reserve vertical padding.
  if (orientation === 'portrait') {
    return { top: 0, right: 0, bottom: gap, left: 0 }
  }
  // In landscape the hinge is vertical → reserve horizontal padding.
  return { top: 0, right: gap, bottom: 0, left: 0 }
}
