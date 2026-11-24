/**
 * Kiosk audit log.
 *
 * Every significant kiosk event (filing, PIN elevation, exit, auto-wipe) is
 * recorded as a signed entry in sessionStorage. Entries are chained via the
 * previous entry's hash so any tampering or deletion is detectable.
 *
 * Signature: SHA-256(prev_hash + type + shelterId + ts).
 * This is lightweight (no asymmetric keys) but provides tamper-evidence
 * sufficient for docs/legal-compliance.md requirements.
 */

import { sha256 } from './crypto'

export type KioskAuditEventType =
  | 'kiosk_start'
  | 'intake_filed'
  | 'pin_elevated'
  | 'pin_demoted'
  | 'pin_failed'
  | 'pin_locked'
  | 'auto_wipe'
  | 'staff_exit'
  | 'language_changed'

export interface KioskAuditEntry {
  type: KioskAuditEventType
  shelterId: string
  ts: number
  /** SHA-256 hex of (prevHash + type + shelterId + ts) */
  sig: string
  /** SHA-256 hex of previous entry, or '0'.repeat(64) for first entry */
  prevHash: string
  meta?: Record<string, string>
}

const AUDIT_KEY = 'hp_kiosk_audit'
const MAX_ENTRIES = 200

function getLog(): KioskAuditEntry[] {
  try {
    return JSON.parse(sessionStorage.getItem(AUDIT_KEY) ?? '[]')
  } catch {
    return []
  }
}

function saveLog(log: KioskAuditEntry[]): void {
  try {
    sessionStorage.setItem(AUDIT_KEY, JSON.stringify(log.slice(-MAX_ENTRIES)))
  } catch {
    // sessionStorage full — drop oldest entries
  }
}

async function computeSig(
  prevHash: string,
  type: string,
  shelterId: string,
  ts: number,
): Promise<string> {
  const data = `${prevHash}|${type}|${shelterId}|${ts}`
  const bytes = await sha256(data)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function appendAuditEvent(
  type: KioskAuditEventType,
  shelterId: string,
  meta?: Record<string, string>,
): Promise<void> {
  const log = getLog()
  const prevHash =
    log.length > 0 ? log[log.length - 1].sig : '0'.repeat(64)
  const ts = Date.now()
  const sig = await computeSig(prevHash, type, shelterId, ts)
  const entry: KioskAuditEntry = { type, shelterId, ts, sig, prevHash, meta }
  log.push(entry)
  saveLog(log)
}

export function getAuditLog(): KioskAuditEntry[] {
  return getLog()
}

/** Verify the hash chain of the stored log. Returns true if intact. */
export async function verifyAuditChain(): Promise<boolean> {
  const log = getLog()
  for (let i = 0; i < log.length; i++) {
    const entry = log[i]
    const expectedPrev = i === 0 ? '0'.repeat(64) : log[i - 1].sig
    if (entry.prevHash !== expectedPrev) return false
    const expectedSig = await computeSig(entry.prevHash, entry.type, entry.shelterId, entry.ts)
    if (entry.sig !== expectedSig) return false
  }
  return true
}
