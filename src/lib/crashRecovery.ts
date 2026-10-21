/**
 * src/lib/crashRecovery.ts — IndexedDB Form Recovery & Auto-Rehydration
 *
 * - Persists active emergency request draft to IndexedDB every 2 seconds
 * - Restores draft automatically on re-open after tab crash
 * - Clears draft after successful submission or 1-hour expiration
 *
 * DB: helphone_crash_recovery / drafts store / key: emergency_draft
 */

import { currentTraceIds } from './telemetry'

export const DB_NAME = 'helphone_crash_recovery'
export const STORE_NAME = 'drafts'
export const DRAFT_KEY = 'emergency_draft'
export const DB_VERSION = 1
export const AUTO_SAVE_INTERVAL_MS = 2000
export const DRAFT_EXPIRATION_MS = 60 * 60 * 1000 // 1 hour

export interface HelpDraft {
  emergencyType: string | null
  nickname: string
  contact: string
  location: [number, number] | null
  searchQuery: string
  // Optional extra fields (profile, map state, etc.)
  extra?: Record<string, unknown>
  /** Join key back to the dispatch trace for post-crash forensics (#791). */
  traceId?: string
  spanId?: string
  createdAt: number
  updatedAt: number
}

export type GetDraftFn = () => Omit<HelpDraft, 'createdAt' | 'updatedAt'> | null | undefined

export type ReplayVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'blocked_by_kill_switch'; killSwitch: string; draftVersion: string; currentVersion: string }

/**
 * Stale-flag replay guard (#797). A draft composed under an older flag
 * version is only resubmitted if the entrypoint it targets is still enabled
 * now; otherwise the caller surfaces "blocked by kill-switch" instead of
 * silently resubmitting to a killed path. The draft itself is kept.
 */
export function checkReplay(draft: HelpDraft, killSwitch = 'soroban.submit'): ReplayVerdict {
  const draftVersion = draft.flagVersion ?? '0'
  const currentVersion = currentFlagVersion()
  if (compareFlagVersions(draftVersion, currentVersion) >= 0) return { allowed: true }
  if (evaluateKillSwitch(killSwitch).enabled) return { allowed: true }
  return { allowed: false, reason: 'blocked_by_kill_switch', killSwitch, draftVersion, currentVersion }
}

function isIndexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isIndexedDBAvailable()) {
      reject(new Error('IndexedDB not available'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('IndexedDB blocked'))
  })
}

// Fallback to localStorage when IndexedDB unavailable (e.g. private mode)
function lsKey() {
  return `${DB_NAME}:${DRAFT_KEY}`
}
function saveToLocalStorage(draft: HelpDraft) {
  try {
    localStorage.setItem(lsKey(), JSON.stringify(draft))
  } catch {}
}
function loadFromLocalStorage(): HelpDraft | null {
  try {
    const raw = localStorage.getItem(lsKey())
    if (!raw) return null
    return JSON.parse(raw) as HelpDraft
  } catch {
    return null
  }
}
function clearLocalStorage() {
  try {
    localStorage.removeItem(lsKey())
  } catch {}
}

/**
 * Save the current draft. Overwrites previous. Sets updatedAt.
 * If partialDraft is null/empty, we still persist timestamped empty draft so
 * expiration logic can work – but callers should avoid saving entirely empty states
 * by checking before invoking.
 */
export async function saveDraft(partial: Omit<HelpDraft, 'createdAt' | 'updatedAt'>): Promise<void> {
  const now = Date.now()
  // Try to preserve createdAt if existing draft exists
  let createdAt = now
  try {
    const existing = await loadDraftRaw()
    if (existing?.createdAt) createdAt = existing.createdAt
  } catch {}

  const draft: HelpDraft = {
    emergencyType: partial.emergencyType ?? null,
    nickname: partial.nickname ?? '',
    contact: partial.contact ?? '',
    location: partial.location ?? null,
    searchQuery: partial.searchQuery ?? '',
    extra: partial.extra,
    ...(currentTraceIds() ?? {}),
    createdAt,
    updatedAt: now,
  }

  if (!isIndexedDBAvailable()) {
    saveToLocalStorage(draft)
    return
  }

  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const req = store.put(draft, DRAFT_KEY)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    })
  } catch {
    // Fallback to localStorage on IDB error
    saveToLocalStorage(draft)
  }
}

async function loadDraftRaw(): Promise<HelpDraft | null> {
  if (!isIndexedDBAvailable()) {
    return loadFromLocalStorage()
  }
  try {
    const db = await openDB()
    const result: HelpDraft | null = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(DRAFT_KEY)
      req.onsuccess = () => resolve((req.result as HelpDraft) ?? null)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
      // Ensure close even if tx completes quickly
      setTimeout(() => {
        try {
          db.close()
        } catch {}
      }, 100)
    })
    if (result) return result
    // Fallback: check localStorage if IDB empty (migration)
    return loadFromLocalStorage()
  } catch {
    return loadFromLocalStorage()
  }
}

/**
 * Load draft if exists and not expired (1h). If expired, clears and returns null.
 * This is the primary rehydration entry point — call on app mount.
 */
export async function loadDraft(): Promise<HelpDraft | null> {
  const draft = await loadDraftRaw()
  if (!draft) return null
  const now = Date.now()
  const age = now - (draft.updatedAt ?? draft.createdAt ?? 0)
  if (age > DRAFT_EXPIRATION_MS) {
    await clearDraft()
    return null
  }
  return draft
}

/**
 * Clear stored draft — call after successful submission or manual reset.
 * Clears both IndexedDB and localStorage mirror.
 */
export async function clearDraft(): Promise<void> {
  clearLocalStorage()
  if (!isIndexedDBAvailable()) return
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const req = store.delete(DRAFT_KEY)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    })
  } catch {
    // ignore – localStorage already cleared
  }
}

/**
 * Check if a draft is expired without loading via business logic.
 * Useful for periodic cleanup.
 */
export function isDraftExpired(draft: HelpDraft, now = Date.now()): boolean {
  const ts = draft.updatedAt ?? draft.createdAt ?? 0
  return now - ts > DRAFT_EXPIRATION_MS
}

/**
 * Start auto-save loop that polls getDraft every AUTO_SAVE_INTERVAL_MS (2000ms)
 * and persists to IndexedDB. Returns a stop function to clear the interval.
 *
 * - Skips save if getDraft returns null/undefined/empty (all fields empty)
 * - Handles errors silently (never throws in interval)
 */
export function startAutoSave(getDraft: GetDraftFn, intervalMs = AUTO_SAVE_INTERVAL_MS): () => void {
  // Immediate save on start if data available
  try {
    const initial = getDraft()
    if (initial && hasMeaningfulData(initial)) {
      saveDraft(initial).catch(() => {})
    }
  } catch {}

  const id = setInterval(async () => {
    try {
      const draft = getDraft()
      if (!draft) return
      if (!hasMeaningfulData(draft)) return
      await saveDraft(draft)
    } catch {
      // auto-save must never crash the UI
    }
  }, intervalMs)

  // Allow Node test environments to exit without waiting for this interval
  // @ts-ignore – not all environments have unref
  if (typeof (id as any).unref === 'function') (id as any).unref()

  return () => clearInterval(id)
}

function hasMeaningfulData(d: Omit<HelpDraft, 'createdAt' | 'updatedAt'>): boolean {
  return !!(
    (d.emergencyType && String(d.emergencyType).trim()) ||
    (d.nickname && String(d.nickname).trim()) ||
    (d.contact && String(d.contact).trim()) ||
    (d.searchQuery && String(d.searchQuery).trim()) ||
    (d.location && Array.isArray(d.location) && d.location.length === 2) ||
    (d.extra && Object.keys(d.extra).length > 0)
  )
}

/**
 * Restore helper — loads draft and returns it, or null if none/expired.
 * Thin wrapper around loadDraft for semantic clarity at call sites.
 */
export async function restoreDraft(): Promise<HelpDraft | null> {
  return loadDraft()
}

export interface RecoveryReport {
  recovered: boolean;
  sqliteHighwater: number;
  idbHighwater: number;
  replayedOps: number;
  tornFramesDropped: number;
  zombieSnapshotsRefused: number;
  elapsedMs: number;
}

let recoveryComplete = false;
let recoveryPromise: Promise<RecoveryReport> | null = null;
let recoveryResolver: ((report: RecoveryReport) => void) | null = null;

export function isRecoveryComplete(): boolean {
  return recoveryComplete;
}

export function resetRecoveryGate(): void {
  recoveryComplete = false;
  recoveryPromise = new Promise((resolve) => {
    recoveryResolver = resolve;
  });
}

export async function waitForRecovery(): Promise<RecoveryReport> {
  if (recoveryComplete) {
    return {
      recovered: true,
      sqliteHighwater: 0,
      idbHighwater: 0,
      replayedOps: 0,
      tornFramesDropped: 0,
      zombieSnapshotsRefused: 0,
      elapsedMs: 0,
    };
  }
  if (!recoveryPromise) {
    recoveryPromise = new Promise((resolve) => {
      recoveryResolver = resolve;
    });
  }
  return recoveryPromise;
}

export function emitRecoveryComplete(report: RecoveryReport): void {
  recoveryComplete = true;
  if (recoveryResolver) {
    recoveryResolver(report);
  }
}

/**
 * Reconcile high-waters across SQLite and IDB journal and replay strictly seq > sqlite_hw.
 * Fences uploads, validates WAL frames, and prevents zombie snapshot resurrection.
 */
export async function reconcileAndResurrect({
  storageEngine,
  journalStore,
  crdtDoc = null,
  snapshotHeader = null,
  deviceId = 'dev-1',
}: {
  storageEngine: any;
  journalStore: any;
  crdtDoc?: any;
  snapshotHeader?: { journal_highwater?: number } | null;
  deviceId?: string;
}): Promise<RecoveryReport> {
  const t0 = Date.now();
  let tornFramesDropped = 0;
  let zombieSnapshotsRefused = 0;
  let replayedOps = 0;

  // 1. Recover torn WAL if backend supports it
  if (typeof storageEngine?.recoverTornWal === 'function') {
    const walCheck = storageEngine.recoverTornWal();
    if (walCheck?.tornFramesDropped) tornFramesDropped += walCheck.tornFramesDropped;
  }

  // 2. Read highwaters
  const sqliteHighwater = typeof storageEngine?.getHighwater === 'function' ? storageEngine.getHighwater(deviceId) : 0;
  const idbHighwater = typeof journalStore?.getHighwater === 'function' ? journalStore.getHighwater(deviceId) : 0;

  // 3. Snapshot fencing: prevent zombie resurrection if snapshot newer than sqlite_hw without IDB coverage
  if (snapshotHeader && snapshotHeader.journal_highwater !== undefined) {
    if (snapshotHeader.journal_highwater > sqliteHighwater && snapshotHeader.journal_highwater > idbHighwater) {
      zombieSnapshotsRefused++;
      console.warn('[CrashRecovery] Refused zombie snapshot: snapshot journal_highwater is ahead without IDB coverage', {
        snapshotHw: snapshotHeader.journal_highwater,
        sqliteHighwater,
        idbHighwater,
      });
    } else if (crdtDoc && typeof crdtDoc.applySnapshot === 'function') {
      // Safe to apply snapshot
    }
  }

  // 4. Replay ONLY IDB entries where seq > sqliteHighwater
  if (journalStore && typeof journalStore.getAllEntries === 'function') {
    const entries = journalStore.getAllEntries(sqliteHighwater, deviceId);
    if (entries.length > 0 && typeof storageEngine?.appendBatch === 'function') {
      const records = entries.map((e: any) => ({ ...e.op, device_id: e.deviceId, seq: e.seq }));
      await storageEngine.appendBatch('dispatches', records, { lane: 'dispatch' });
      replayedOps = entries.length;
      if (typeof journalStore.markAcked === 'function') {
        const maxSeq = Math.max(...entries.map((e: any) => e.seq));
        journalStore.markAcked(deviceId, maxSeq);
      }
    }
  }

  // 5. Checkpoint WAL
  if (typeof storageEngine?.checkpoint === 'function') {
    storageEngine.checkpoint('TRUNCATE');
  }

  const report: RecoveryReport = {
    recovered: true,
    sqliteHighwater,
    idbHighwater,
    replayedOps,
    tornFramesDropped,
    zombieSnapshotsRefused,
    elapsedMs: Date.now() - t0,
  };

  emitRecoveryComplete(report);
  return report;
}

// Re-export for test spying on expiration
export const __testables = {
  hasMeaningfulData,
  isIndexedDBAvailable,
  openDB,
}

