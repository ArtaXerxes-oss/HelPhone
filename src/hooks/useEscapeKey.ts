/**
 * useEscapeKey — calls `onEscape` when the Escape key is pressed.
 *
 * Canonical module (#901): this replaces the former `useEscapeKey.js`, whose
 * positional `(active, onClose)` API is now `useEscapeKey(onClose, { enabled:
 * active, restoreFocus: true })`.
 *
 * - Normal mode (dialogs, sheets): a document-level listener; Escape is
 *   handled after the focused element has seen it, and does not propagate
 *   further once handled.
 * - Kiosk mode: Escape only moves back one step in the intake flow. It is
 *   caught in the capture phase and never reaches browser/OS handlers that
 *   could leave the kiosk route.
 * - `restoreFocus`: when the listener is torn down (the dialog closes), focus
 *   returns to the element that had it when the dialog opened.
 */
import { useEffect, useRef } from 'react'

export interface UseEscapeKeyOptions {
  /** When true, Escape only fires `onEscape` — it does NOT close dialogs or
   *  navigate. Callers should map it to "go one step back inside the flow". */
  kioskMode?: boolean
  /** Set to false to temporarily suspend the listener (e.g. while a PIN pad
   *  is open — the PIN pad manages its own key handling, or while a dialog is
   *  closed). Defaults to true. */
  enabled?: boolean
  /** Return focus to the previously focused element when the listener stops. */
  restoreFocus?: boolean
}

export function useEscapeKey(onEscape: () => void, options: UseEscapeKeyOptions = {}): void {
  const { kioskMode = false, enabled = true, restoreFocus = false } = options
  const previousFocusRef = useRef<Element | null>(null)

  useEffect(() => {
    if (!enabled) return undefined
    if (restoreFocus) previousFocusRef.current = document.activeElement

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || typeof onEscape !== 'function') return
      if (kioskMode) {
        // Consumed here and remapped to "step back"; it must never bubble up
        // to handlers that could leave the kiosk scope.
        event.preventDefault()
      }
      event.stopPropagation()
      onEscape()
    }

    const target: Document | Window = kioskMode ? window : document
    const listenerOptions = { capture: kioskMode }
    target.addEventListener('keydown', handleKeyDown as EventListener, listenerOptions)
    return () => {
      target.removeEventListener('keydown', handleKeyDown as EventListener, listenerOptions)
      if (!restoreFocus) return
      const previous = previousFocusRef.current
      if (previous instanceof HTMLElement) {
        // A microtask, so this runs after a focus trap's own cleanup.
        queueMicrotask(() => {
          try {
            previous.focus()
          } catch {
            /* element gone */
          }
        })
      }
    }
  }, [onEscape, kioskMode, enabled, restoreFocus])
}

export default useEscapeKey
