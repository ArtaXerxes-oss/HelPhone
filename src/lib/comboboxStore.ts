/**
 * src/lib/comboboxStore.ts — Lifted combobox state store (ISP-140)
 *
 * Help.jsx's location search combobox (query text, highlighted suggestion
 * index, open/closed, pending geocode request id) was held entirely in
 * local `useState`. When fold/orientation churn causes breakpoint-driven
 * conditional rendering to unmount and remount the combobox, the state is
 * wiped — a half-typed "123 Fifth" vanishes mid-dispatch.
 *
 * This module lifts that state into a singleton store so remounts restore
 * byte-identical combobox state. It is intentionally NOT persisted across
 * sessions or users (no localStorage / SecureStorage) to avoid the PII leak
 * risk noted in ISP-136. State is cleared on user change or submission.
 */

/** Combobox state shape — mirrors the local useState fields in Help.jsx. */
export interface ComboboxState {
  /** Current query text in the search input. */
  query: string
  /** Active (highlighted) suggestion index, or -1 if none. */
  activeSuggestion: number
  /** Whether the suggestion dropdown is open. */
  isOpen: boolean
  /** Pending geocode request ID (to resume/cancel on remount). */
  geocodeReqId: string | null
  /** Caret position for Input.jsx preservation (selectionStart). */
  caretPos: number | null
  /** Timestamp of the last update (for staleness checks). */
  updatedAt: number
}

const INITIAL_STATE: ComboboxState = {
  query: '',
  activeSuggestion: -1,
  isOpen: false,
  geocodeReqId: null,
  caretPos: null,
  updatedAt: 0,
}

/** Singleton state holder. */
let state: ComboboxState = { ...INITIAL_STATE }

/** Simple subscription set for React integration. */
const listeners = new Set<() => void>()

/** Get the current combobox state (synchronous — safe for remount reads). */
export function getComboboxState(): ComboboxState {
  return { ...state }
}

/** Partially update the combobox state and notify subscribers. */
export function setComboboxState(partial: Partial<ComboboxState>): void {
  state = { ...state, ...partial, updatedAt: Date.now() }
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (err) {
      console.warn('[comboboxStore] listener error:', err)
    }
  }
}

/** Subscribe to state changes. Returns an unsubscribe function. */
export function subscribeToCombobox(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reset combobox state to initial values (call after submission or user change). */
export function resetComboboxState(): void {
  state = { ...INITIAL_STATE }
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (err) {
      console.warn('[comboboxStore] listener error on reset:', err)
    }
  }
}
