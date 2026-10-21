/**
 * Persistent offline outbox (localStorage-backed) with priority lanes and
 * idempotency keys. Shared by the radio bridge (ISP-135), NFC check-in
 * (ISP-134) and hardware SOS (ISP-131) so an intent created without network
 * drains exactly once when any transport returns.
 *
 * NOTE: entries hold field payloads that may include PII — callers must
 * redact per band plan (see src/lib/radio/bandPlan.js) before enqueueing in
 * ham mode, and must never store raw secrets here.
 */

const STORAGE_KEY = "hp_offline_queue";

/** Priority lanes — lower value drains first (SOS preempts everything). */
export const PRIO = Object.freeze({ SOS: 0, NEW: 1, ROSTER: 2, LOC: 3 });

let seqCounter = 0;

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (v && Array.isArray(v.items)) {
      seqCounter = Math.max(seqCounter, v.seq || 0);
      return v;
    }
  } catch {
    // best-effort — surface failures are non-fatal here
  }
  return { seq: 0, items: [] };
}

function save(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // best-effort — surface failures are non-fatal here
  }
}

function nextSeq(state) {
  state.seq += 1;
  seqCounter = state.seq;
  return state.seq;
}

/**
 * Enqueue an intent. Deduplicates by idempotencyKey: re-enqueueing the same
 * key returns the existing entry (exactly-once semantics across bounce,
 * double-scan, radio+WS double-delivery).
 * @returns {{entry: object, duplicate: boolean}}
 */
export function enqueue({ kind, prio = PRIO.NEW, idempotencyKey, data = {} }) {
  const state = load();
  if (idempotencyKey) {
    const existing = state.items.find(
      (i) => i.idempotencyKey === idempotencyKey,
    );
    if (existing) return { entry: existing, duplicate: true };
  }
  const entry = {
    id: `q-${Date.now().toString(36)}-${nextSeq(state).toString(36)}`,
    kind,
    prio: Math.max(0, Math.min(3, prio | 0)),
    idempotencyKey: idempotencyKey || null,
    data,
    seq: state.seq,
    createdAt: Date.now(),
  };
  state.items.push(entry);
  save(state);
  return { entry, duplicate: false };
}

/** Queue ordered by priority lane, then insertion order. */
export function listQueue({ limit = 500 } = {}) {
  const state = load();
  return [...state.items]
    .sort((a, b) => a.prio - b.prio || a.seq - b.seq)
    .slice(0, limit);
}

export function removeEntry(id) {
  const state = load();
  const before = state.items.length;
  state.items = state.items.filter((i) => i.id !== id);
  save(state);
  return state.items.length < before;
}

export function clearQueue() {
  save({ seq: load().seq, items: [] });
}

export function queueDepth() {
  return load().items.length;
}

export function queueByKind(kind) {
  return listQueue().filter((i) => i.kind === kind);
}

export function findByIdempotencyKey(key) {
  if (!key) return null;
  return load().items.find((i) => i.idempotencyKey === key) || null;
}
