/**
 * Client-side view of the contract's bounded verification history (#531).
 *
 * Mirrors `contract/contracts/helphone-contract/src/ring_buffer.rs`: logical
 * indexes only grow, and once more than `capacity` entries exist the oldest
 * `total - capacity` of them are gone.
 */
import type { ExpertVerificationWindow } from '../types/index'

function toCount(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/** Derive the readable window from the contract's lifetime total and capacity. */
export function verificationWindow(total: unknown, capacity: unknown): ExpertVerificationWindow {
  const t = toCount(total)
  const c = toCount(capacity)
  const oldest = Math.max(t - c, 0)
  return { total: t, capacity: c, oldest, retained: t - oldest, evicted: oldest }
}

/** Whether logical `index` can still be read from the contract. */
export function isRetained(window: ExpertVerificationWindow, index: number): boolean {
  return Number.isInteger(index) && index >= window.oldest && index < window.total
}

/**
 * Logical indexes of the newest `limit` retained entries, newest first: what
 * to fetch to show a wallet's recent history without asking for evicted slots.
 */
export function recentIndexes(window: ExpertVerificationWindow, limit: number): number[] {
  const count = Math.min(Math.max(Math.trunc(limit) || 0, 0), window.retained)
  return Array.from({ length: count }, (_, i) => window.total - 1 - i)
}

/**
 * Fixed-capacity audit tape (#797): kill-switch changes, newest overwrites
 * oldest. Capacity is fixed at construction so the tape never grows under
 * memory pressure; `approxBytes` lets heap forensics (#793) account for it.
 */
export interface AuditEntry {
  at: number
  kind: string
  from: string
  to: string
}

export function createAuditTape(capacity = 64) {
  const slots: Array<AuditEntry | undefined> = new Array(capacity)
  let total = 0
  return {
    push(entry: AuditEntry): void {
      slots[total % capacity] = entry
      total += 1
    },
    /** Retained entries, oldest first. */
    entries(): AuditEntry[] {
      const w = verificationWindow(total, capacity)
      return Array.from({ length: w.retained }, (_, i) => slots[(w.oldest + i) % capacity]!)
    },
    get total(): number {
      return total
    },
    /** Rough retained size: ~64 bytes per entry plus short strings. */
    approxBytes(): number {
      return Math.min(total, capacity) * 96
    },
  }
}
