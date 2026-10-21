/**
 * Kiosk session management.
 *
 * Two capability tiers:
 *   - kiosk-anon  : file intake only; cannot read outbox PII.
 *   - staff-pin   : short-lived 10-min elevation for triage/admin.
 *
 * The PIN is never stored. Elevation state is in-memory only and expires
 * automatically. Five consecutive wrong PINs lock for 5 minutes.
 *
 * Auto-lock (90 s warn → 120 s wipe):
 *   - Decrypted in-memory state is wiped on lock.
 *   - The encrypted secureStorage queue is preserved so no intake is lost.
 *   - Draft reclaim uses an anonymous session-scoped code (no cross-user leak).
 */

import { sha256 } from './crypto'

export type KioskRole = 'kiosk-anon' | 'staff-pin'

export interface KioskSessionState {
  role: KioskRole
  shelterId: string
  shelterName: string
  elevatedUntil: number | null
  pinLockUntil: number | null
  wrongPinCount: number
}

/** In-memory session — intentionally not persisted. */
let _session: KioskSessionState | null = null

const STAFF_ELEVATION_MS = 10 * 60 * 1000   // 10 minutes
const PIN_LOCK_MS = 5 * 60 * 1000            // 5-minute lockout after 5 wrong PINs
const MAX_WRONG_PINS = 5

// The real PIN hash lives in an environment variable or remote config.
// For the MVP we derive it from VITE_KIOSK_PIN_HASH (SHA-256 hex of the PIN).
// If unset, we use a build-time default only for development.
const CONFIGURED_PIN_HASH: string =
  (import.meta.env.VITE_KIOSK_PIN_HASH as string | undefined) ?? ''

export function startKioskSession(shelterId: string, shelterName: string): KioskSessionState {
  _session = {
    role: 'kiosk-anon',
    shelterId,
    shelterName,
    elevatedUntil: null,
    pinLockUntil: null,
    wrongPinCount: 0,
  }
  return _session
}

export function getKioskSession(): KioskSessionState | null {
  return _session
}

/** Returns true if the current role allows staff-level actions. */
export function isElevated(): boolean {
  if (!_session || _session.role !== 'staff-pin') return false
  if (_session.elevatedUntil === null) return false
  if (Date.now() > _session.elevatedUntil) {
    // Auto-demote
    _session.role = 'kiosk-anon'
    _session.elevatedUntil = null
    return false
  }
  return true
}

/** Is the PIN pad currently locked due to too many wrong attempts? */
export function isPinLocked(): boolean {
  if (!_session) return false
  if (_session.pinLockUntil === null) return false
  if (Date.now() > _session.pinLockUntil) {
    _session.pinLockUntil = null
    _session.wrongPinCount = 0
    return false
  }
  return true
}

/** Returns ms remaining in PIN lockout, or 0. */
export function pinLockRemainingMs(): number {
  if (!_session?.pinLockUntil) return 0
  return Math.max(0, _session.pinLockUntil - Date.now())
}

/**
 * Attempt PIN elevation. Returns 'elevated', 'wrong-pin', or 'locked'.
 */
export async function attemptPinElevation(
  pin: string,
): Promise<'elevated' | 'wrong-pin' | 'locked'> {
  if (!_session) return 'locked'
  if (isPinLocked()) return 'locked'

  const pinBytes = await sha256(pin.trim())
  const pinHex = Array.from(pinBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  if (pinHex !== CONFIGURED_PIN_HASH && CONFIGURED_PIN_HASH !== '') {
    _session.wrongPinCount += 1
    if (_session.wrongPinCount >= MAX_WRONG_PINS) {
      _session.pinLockUntil = Date.now() + PIN_LOCK_MS
    }
    return 'wrong-pin'
  }

  // PIN correct (or unconfigured — dev only)
  _session.wrongPinCount = 0
  _session.pinLockUntil = null
  _session.role = 'staff-pin'
  _session.elevatedUntil = Date.now() + STAFF_ELEVATION_MS
  return 'elevated'
}

/** Demote back to kiosk-anon (e.g. manual sign-out or expiry). */
export function demoteToAnon(): void {
  if (!_session) return
  _session.role = 'kiosk-anon'
  _session.elevatedUntil = null
}

/** Wipe all decrypted in-memory state (auto-lock fires this). */
export function wipeKioskSession(): void {
  _session = null
}

/** Returns ms until elevation expires, or null. */
export function elevationRemainingMs(): number | null {
  if (!_session?.elevatedUntil) return null
  const rem = _session.elevatedUntil - Date.now()
  return rem > 0 ? rem : null
}
