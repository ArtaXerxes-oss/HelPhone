/**
 * useEscapeKey — listens for the Escape key.
 *
 * In kiosk mode the handler only moves back one step in the intake flow;
 * it never navigates away from the kiosk route. In normal mode it calls
 * the provided `onEscape` callback directly.
 */
import { useEffect } from 'react'

export interface UseEscapeKeyOptions {
  /** When true, Escape only fires `onEscape` — it does NOT close dialogs or
   *  navigate. Callers should map it to "go one step back inside the flow". */
  kioskMode?: boolean
  /** Set to false to temporarily suspend the listener (e.g. while a PIN pad
   *  is open — the PIN pad manages its own key handling). */
  enabled?: boolean
}

export function useEscapeKey(
  onEscape: () => void,
  options: UseEscapeKeyOptions = {},
): void {
  const { kioskMode = false, enabled = true } = options

  useEffect(() => {
    if (!enabled) return

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return

      if (kioskMode) {
        // In kiosk mode Escape is consumed here and remapped to "step back".
        // It must never bubble up to browser/OS handlers that could leave scope.
        event.preventDefault()
        event.stopPropagation()
        onEscape()
        return
      }

      onEscape()
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [onEscape, kioskMode, enabled])
}
