/**
 * Offline storage quota, eviction and persistence policy (#895, ADR-007).
 *
 * Three pieces:
 *
 *  1. `requestPersistentStorage()` — asks the browser once per origin, on the
 *     first incident join, to make our storage persistent
 *     (`navigator.storage.persist()`), so eviction under storage pressure
 *     cannot wipe an incident's offline data. The call is one-shot: the
 *     outcome is recorded, later joins reuse it, and listeners can observe
 *     the state.
 *
 *  2. `createRetentionManager()` — keeps usage under a budget by deleting the
 *     oldest telemetry. Only stores listed as evictable (telemetry, render
 *     frames) are ever deleted from; broadcast messages and dispatches are
 *     never evicted.
 *
 *  3. `appendWithQuotaRecovery()` — on a quota error, evicts the oldest
 *     telemetry and retries once. A message or dispatch that still does not
 *     fit is surfaced as an error, never dropped.
 */

import { isQuotaError } from "./storageEngine.js";

export const PERSIST_STATE_KEY = "hp_storage_persist_v1";

/** Stores whose oldest records may be deleted to free space, in eviction order. */
export const EVICTABLE_STORES = Object.freeze(["frames", "telemetry"]);
/** Stores that are never evicted: zero-delay-flush, lossless lanes. */
export const PROTECTED_STORES = Object.freeze(["messages", "dispatches"]);

// ── 1. One-shot persistence request ─────────────────────────────────────────

const listeners = new Set();
let inflight = null;
let memoryState = null;

function defaultStore() {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // storage disabled (private mode, sandboxed iframe)
  }
  return null;
}

function readState(kv) {
  if (memoryState) return memoryState;
  try {
    const raw = kv && kv.getItem(PERSIST_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.status === "string") return (memoryState = parsed);
    }
  } catch {
    // corrupt entry: treat as never requested
  }
  return null;
}

function writeState(kv, state) {
  memoryState = state;
  try {
    if (kv) kv.setItem(PERSIST_STATE_KEY, JSON.stringify(state));
  } catch {
    // best effort: the in-memory copy still makes this tab one-shot
  }
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch {
      // a listener must not break the request
    }
  }
}

/**
 * Current persistence state, or null if never requested:
 *   { status: "granted" | "denied" | "unsupported" | "already-persisted",
 *     requestedAt: ISO string, trigger: string }
 */
export function getPersistenceState({ kv = defaultStore() } = {}) {
  return readState(kv);
}

/** Subscribe to persistence state changes. Returns an unsubscribe function. */
export function onPersistenceChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Ask for persistent storage at most once per origin.
 *
 * - Already persisted: recorded as "already-persisted", no prompt.
 * - No StorageManager.persist (older Safari, Node): "unsupported".
 * - Otherwise calls `persist()` once and records "granted" or "denied".
 * Concurrent calls share one request; later calls return the recorded state
 * without calling `persist()` again.
 */
export async function requestPersistentStorage({
  trigger = "incident-join",
  storage = typeof navigator !== "undefined" ? navigator.storage : undefined,
  kv = defaultStore(),
  now = () => new Date(),
} = {}) {
  const recorded = readState(kv);
  if (recorded) return recorded;
  if (inflight) return inflight;
  inflight = (async () => {
    const stamp = { requestedAt: now().toISOString(), trigger };
    let status;
    if (!storage || typeof storage.persist !== "function") status = "unsupported";
    else {
      try {
        if (typeof storage.persisted === "function" && (await storage.persisted())) status = "already-persisted";
        else status = (await storage.persist()) ? "granted" : "denied";
      } catch {
        status = "denied";
      }
    }
    const state = { status, ...stamp };
    writeState(kv, state);
    return state;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Test hook: forget the in-memory state (the kv store is left alone). */
export function _resetPersistenceForTests() {
  memoryState = null;
  inflight = null;
  listeners.clear();
}

// ── 2. Oldest-telemetry retention ───────────────────────────────────────────

/**
 * @param {object} options
 * @param {{ count(store): Promise<number>, deleteOldest(store, n): Promise<number> }} options.engine
 * @param {() => Promise<{ usage: number, quota: number } | null>} options.estimate
 *   storage estimate (navigator.storage.estimate); null skips the usage check
 * @param {number} [options.highWater=0.8] start evicting above this share of quota
 * @param {number} [options.lowWater=0.6] evict until usage is below this share
 * @param {Record<string, number>} [options.maxRecords] hard per-store record caps
 * @param {number} [options.chunk=500] records deleted per step
 */
export function createRetentionManager({
  engine,
  estimate,
  highWater = 0.8,
  lowWater = 0.6,
  maxRecords = { telemetry: 200_000, frames: 2_000 },
  chunk = 500,
  stores = EVICTABLE_STORES,
} = {}) {
  if (!(lowWater > 0 && lowWater < highWater && highWater <= 1)) throw new RangeError("need 0 < lowWater < highWater <= 1");
  for (const s of stores)
    if (PROTECTED_STORES.includes(s)) throw new RangeError(`"${s}" is a protected store and cannot be evicted`);
  const metrics = { runs: 0, evicted: {}, lastRun: null };

  async function evict(store, n) {
    const deleted = await engine.deleteOldest(store, n);
    metrics.evicted[store] = (metrics.evicted[store] || 0) + deleted;
    return deleted;
  }

  return {
    /** Applies the record caps, then the usage budget. Returns what was deleted. */
    async enforce() {
      metrics.runs++;
      const deleted = {};
      for (const store of stores) {
        const cap = maxRecords[store];
        if (!Number.isFinite(cap)) continue;
        const over = (await engine.count(store)) - cap;
        if (over > 0) deleted[store] = (deleted[store] || 0) + (await evict(store, over));
      }
      let usage = estimate ? await estimate() : null;
      if (usage && usage.quota > 0 && usage.usage / usage.quota > highWater) {
        for (const store of stores) {
          while (usage.usage / usage.quota > lowWater) {
            const n = await evict(store, chunk);
            if (!n) break;
            deleted[store] = (deleted[store] || 0) + n;
            usage = await estimate();
            if (!usage) break;
          }
          if (!usage || usage.usage / usage.quota <= lowWater) break;
        }
      }
      metrics.lastRun = { deleted, usage };
      return { deleted, usage };
    },
    stats: () => ({ ...metrics, evicted: { ...metrics.evicted } }),
  };
}

// ── 3. Quota-safe append ────────────────────────────────────────────────────

/**
 * Appends a record; on a quota error, deletes the oldest `evictCount`
 * telemetry records and retries once. Protected stores (messages,
 * dispatches) free space by evicting telemetry, never themselves; if the
 * retry also fails, the error is thrown so the caller can surface it.
 */
export async function appendWithQuotaRecovery(engine, store, record, { evictCount = 1000, evictFrom = EVICTABLE_STORES } = {}) {
  try {
    return await engine.append(store, record);
  } catch (err) {
    if (!isQuotaError(err)) throw err;
    let freed = 0;
    for (const s of evictFrom) {
      if (PROTECTED_STORES.includes(s)) continue;
      freed += await engine.deleteOldest(s, evictCount);
      if (freed >= evictCount) break;
    }
    if (!freed) throw err;
    return engine.append(store, record);
  }
}
