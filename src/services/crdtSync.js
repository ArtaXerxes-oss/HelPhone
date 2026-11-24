/**
 * Off-grid incident map synchronisation prototypes (spike #604, ADR-004).
 *
 * Two engines over the same data model — a map of entity id → value
 * (responder coordinates, incident status) — so their memory and wire costs
 * can be compared on an identical mutation stream:
 *
 *  1. `StateVectorDoc` — a delta-state LWW-map CRDT in the style of Yjs:
 *     every op carries (client, clock, lamport); peers exchange state vectors
 *     and ship only missing ops. Superseded ops are tombstones. Unlike Yjs,
 *     it supports *causal-stability pruning*: once the peers we sync with
 *     all cover an op, it is dropped from the log, bounding memory over long
 *     incidents; peers behind that frontier get a snapshot of what they
 *     lack. Delete tombstones follow stricter rules (see `prune`).
 *
 *  2. `OtServer` / `OtClient` — "light" operational transformation: a single
 *     sequencer (the incident commander's device, off-grid) orders ops,
 *     transforms late ops against concurrent ones, and periodically folds
 *     its op log into a snapshot. Clients coalesce queued offline ops before
 *     reconnecting.
 *
 * Both are deliberately dependency-free prototypes; they are not wired into
 * the app. See docs/adr/ADR-004-offgrid-map-sync.md.
 */

// ── Shared helpers ──────────────────────────────────────────────────────────

// stateDigest now lives in src/lib/syncIntegrity.js so the server can compute
// the same convergence digest (#932). Re-exported here for existing callers.
import { stateDigest, sha256Hex, isValidVector, sumVector, vectorAdvances, opIdentity } from "../lib/syncIntegrity.js";
import { createJoinReceipt, verifyJoinCompleteness } from "../lib/joinReceipt.js";
import { requestPersistentStorage } from "./storagePolicy.js";
export { stateDigest };

/** UTF-8 byte length of the JSON wire encoding. */
export function wireSize(payload) {
  const json = JSON.stringify(payload);
  return typeof TextEncoder !== "undefined"
    ? new TextEncoder().encode(json).length
    : json.length;
}

// ── 1. State-vector CRDT with causal-stability pruning ──────────────────────

const wins = (a, b) =>
  a.lamport > b.lamport || (a.lamport === b.lamport && a.client > b.client);

export class StateVectorDoc {
  /**
   * @param {string} clientId unique replica id
   * @param {{ gcContent?: boolean }} [options] drop values of superseded ops
   *   (Yjs `gc: true` equivalent) while keeping their ids in the log.
   */
  constructor(clientId, { gcContent = true } = {}) {
    this.clientId = clientId;
    this.gcContent = gcContent;
    this.clock = 0;
    this.lamport = 0;
    /** key → winning op (includes delete tombstones) */
    this.entries = new Map();
    /** client → contiguous op array; ops[i].clock === base + i + 1 */
    this.log = new Map();
    /** client → highest integrated clock */
    this.sv = new Map();
    /** client → clock at/below which ops were pruned (no longer servable) */
    this.frontier = new Map();
    /** client → [[clock, lamport], ...] recorded at each prune cut */
    this.cuts = new Map();
    /** out-of-order ops waiting for their predecessors */
    this.pending = new Map();
  }

  set(key, value) {
    return this.#local(key, value, false);
  }

  delete(key) {
    return this.#local(key, null, true);
  }

  get(key) {
    const e = this.entries.get(key);
    return e && !e.deleted ? e.value : undefined;
  }

  /** Visible (non-deleted) state as a plain Map. */
  toMap() {
    const out = new Map();
    for (const [k, e] of this.entries) if (!e.deleted) out.set(k, e.value);
    return out;
  }

  stateVector() {
    return Object.fromEntries(this.sv);
  }

  #local(key, value, deleted) {
    const op = {
      key,
      value,
      deleted,
      client: this.clientId,
      clock: ++this.clock,
      lamport: ++this.lamport,
    };
    this.#integrate(op);
    return op;
  }

  #integrate(op) {
    const have = this.sv.get(op.client) || 0;
    if (op.clock <= have) return false; // duplicate
    if (op.clock !== have + 1) {
      // Gap: buffer until predecessors arrive.
      let q = this.pending.get(op.client);
      if (!q) this.pending.set(op.client, (q = new Map()));
      q.set(op.clock, op);
      return false;
    }
    this.sv.set(op.client, op.clock);
    if (op.lamport > this.lamport) this.lamport = op.lamport;
    if (op.client === this.clientId && op.clock > this.clock) this.clock = op.clock;

    let ops = this.log.get(op.client);
    if (!ops) {
      ops = [];
      ops.base = op.clock - 1;
      this.log.set(op.client, ops);
    }
    const stored = { ...op, superseded: false };
    ops.push(stored);

    const current = this.entries.get(op.key);
    if (!current || wins(stored, current)) {
      if (current) this.#tombstone(current);
      this.entries.set(op.key, stored);
    } else {
      this.#tombstone(stored);
    }

    const q = this.pending.get(op.client);
    const next = q && q.get(op.clock + 1);
    if (next) {
      q.delete(next.clock);
      if (!q.size) this.pending.delete(op.client);
      this.#integrate(next);
    }
    return true;
  }

  #tombstone(op) {
    op.superseded = true;
    if (this.gcContent) op.value = null;
  }

  /**
   * Ops the holder of `remoteSV` is missing. If any of them were pruned
   * here, returns a full snapshot instead (state-based fallback).
   */
  encodeUpdate(remoteSV = {}) {
    for (const [client, pruned] of this.frontier)
      if ((remoteSV[client] || 0) < pruned) return this.encodeSnapshot(remoteSV);
    const ops = [];
    for (const [client, clientOps] of this.log) {
      const from = (remoteSV[client] || 0) - clientOps.base;
      for (let i = Math.max(0, from); i < clientOps.length; i++) {
        const o = clientOps[i];
        ops.push([o.key, o.superseded && this.gcContent ? null : o.value, o.deleted ? 1 : 0, o.client, o.clock, o.lamport]);
      }
    }
    return { type: "delta", lamport: this.lamport, ops };
  }

  /**
   * Winning entries (incl. delete tombstones) + the state vector they cover.
   * With `remoteSV`, entries whose op the peer already integrated are left
   * out: the peer holds that op or something that beats it, so resending
   * it cannot change its state. This keeps frontier fallbacks small.
   */
  encodeSnapshot(remoteSV = null) {
    const entries = [];
    for (const e of this.entries.values())
      if (!remoteSV || e.clock > (remoteSV[e.client] || 0))
        entries.push([e.key, e.value, e.deleted ? 1 : 0, e.client, e.clock, e.lamport]);
    return { type: "snapshot", lamport: this.lamport, sv: this.stateVector(), entries };
  }

  applyUpdate(update) {
    // Adopt the sender's Lamport time so our next ops outrank everything it
    // has seen, including tombstones it may since have pruned.
    if (update.lamport > this.lamport) this.lamport = update.lamport;
    if (update.type === "snapshot") return this.#applySnapshot(update);
    let applied = 0;
    // Integrate per client in clock order so the log stays contiguous.
    const sorted = update.ops.slice().sort((a, b) => (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : a[4] - b[4]));
    for (const [key, value, deleted, client, clock, lamport] of sorted)
      if (this.#integrate({ key, value, deleted: deleted === 1, client, clock, lamport })) applied++;
    return applied;
  }

  #applySnapshot({ sv, entries }) {
    let applied = 0;
    for (const [key, value, deleted, client, clock, lamport] of entries) {
      const op = { key, value, deleted: deleted === 1, client, clock, lamport, superseded: false };
      const current = this.entries.get(key);
      if (!current || wins(op, current)) {
        if (current) this.#tombstone(current);
        this.entries.set(key, op);
        applied++;
      }
      if (lamport > this.lamport) this.lamport = lamport;
    }
    // Everything up to `sv` is now reflected; we cannot serve it as deltas.
    for (const [client, clock] of Object.entries(sv)) {
      if ((this.sv.get(client) || 0) < clock) {
        this.sv.set(client, clock);
        this.log.delete(client);
        this.frontier.set(client, clock); // no cut point: Lamport time unknown
      }
      if (client === this.clientId && clock > this.clock) this.clock = clock;
    }
    for (const [client, q] of this.pending) {
      const have = this.sv.get(client) || 0;
      for (const c of [...q.keys()]) if (c <= have) q.delete(c);
      const next = q.get(have + 1);
      if (next) {
        q.delete(have + 1);
        this.#integrate(next);
      }
      if (!q.size) this.pending.delete(client);
    }
    return applied;
  }

  /**
   * Discards logged ops covered by `stableSV` and delete tombstones that
   * can no longer affect the outcome of any merge.
   *
   * Log ops at/below `stableSV` (element-wise minimum of the state vectors
   * of the peers we still sync with) are only needed to serve deltas, and
   * those peers already have them; anyone further behind gets a snapshot.
   *
   * Delete tombstones need two stronger conditions:
   *  1. Every replica on the `roster` (all devices that may come back) has
   *     seen the delete — `tombstoneSV` must be computed over the full
   *     roster. Otherwise an evicted device returns with its stale value and
   *     nothing tells it the key was deleted.
   *  2. No op still in flight can lose to it: for every client, the Lamport
   *     time of its last op covered by `tombstoneSV` is >= the tombstone's.
   *     Anything not yet delivered everywhere then outranks the delete, so
   *     replicas agree whether or not they still hold it.
   * Roster members missing from every state vector pin all tombstones.
   *
   * @param {Record<string, number>} stableSV frontier for log pruning
   * @param {string[]} [roster] every replica id that may still sync
   * @param {Record<string, number>} [tombstoneSV] full-roster stable vector
   *   (defaults to `stableSV`, correct when it already spans the roster)
   * @param {string[]} [retired] clients removed from the roster for good
   *   (#894). They are left out of condition 2: the caller guarantees none of
   *   their ops will be integrated again, so none can be in flight.
   */
  prune(stableSV, roster = [], tombstoneSV = stableSV, retired = []) {
    let droppedOps = 0;
    let droppedTombstones = 0;
    let horizon = Infinity;
    const skip = new Set(retired);
    for (const client of new Set([...this.sv.keys(), ...Object.keys(tombstoneSV), ...roster]))
      if (!skip.has(client)) horizon = Math.min(horizon, this.#lamportFloor(client, tombstoneSV[client] || 0));

    for (const [client, ops] of this.log) {
      const stable = stableSV[client] || 0;
      const cut = Math.min(ops.length, Math.max(0, stable - ops.base));
      if (cut <= 0) continue;
      const kept = ops.slice(cut);
      kept.base = ops.base + cut;
      if ((this.frontier.get(client) || 0) < kept.base) this.frontier.set(client, kept.base);
      let cuts = this.cuts.get(client);
      if (!cuts) this.cuts.set(client, (cuts = []));
      cuts.push([kept.base, ops[cut - 1].lamport]);
      if (cuts.length > 64) cuts.shift(); // older cut points only lose precision
      this.log.set(client, kept);
      droppedOps += cut;
    }
    for (const [key, e] of this.entries) {
      if (e.deleted && e.clock <= (tombstoneSV[e.client] || 0) && e.lamport <= horizon) {
        this.entries.delete(key);
        droppedTombstones++;
      }
    }
    return { droppedOps, droppedTombstones };
  }

  /**
   * A lower bound on the Lamport time of `client`'s op at `clock`: exact
   * while the op is still logged, else the latest recorded prune cut at or
   * below it (Lamport times grow with clock), else 0 — which keeps
   * tombstones, the safe direction.
   */
  #lamportFloor(client, clock) {
    if (clock <= 0) return 0;
    const ops = this.log.get(client);
    if (ops && clock > ops.base && clock - ops.base <= ops.length) return ops[clock - ops.base - 1].lamport;
    const cuts = this.cuts.get(client);
    let best = 0;
    if (cuts) for (const [c, lamport] of cuts) if (c <= clock) best = lamport;
    return best;
  }

  stats() {
    let logOps = 0;
    let tombstones = 0;
    for (const ops of this.log.values()) {
      logOps += ops.length;
      for (const o of ops) if (o.superseded) tombstones++;
    }
    let deletes = 0;
    for (const e of this.entries.values()) if (e.deleted) deletes++;
    return { entries: this.entries.size - deletes, deleteTombstones: deletes, logOps, tombstones };
  }
}

/** Element-wise minimum of state vectors: what every peer has seen. */
export function stableStateVector(stateVectors) {
  if (!stateVectors.length) return {};
  const clients = new Set(stateVectors.flatMap((sv) => Object.keys(sv)));
  const out = {};
  for (const c of clients) out[c] = Math.min(...stateVectors.map((sv) => sv[c] || 0));
  return out;
}

/** Bidirectional delta exchange between two replicas. Returns bytes moved. */
export function syncPair(a, b) {
  const toB = a.encodeUpdate(b.stateVector());
  const toA = b.encodeUpdate(a.stateVector());
  b.applyUpdate(toB);
  a.applyUpdate(toA);
  return wireSize(toB) + wireSize(toA);
}

// ── 2. Light OT with server snapshots ───────────────────────────────────────

/**
 * Op shapes: ["set", key, value] | ["del", key] | ["patch", key, fields]
 *
 * Transform of an incoming op against an already-sequenced concurrent op:
 *  - patch after a concurrent del of the same key → dropped (entity gone)
 *  - patch after a concurrent set → still applied on top (field merge)
 *  - set / del → unchanged (sequencer order = last-writer-wins)
 */
export function transformOp(op, against) {
  if (!op || op[1] !== against[1]) return op;
  if (op[0] === "patch" && against[0] === "del") return null;
  return op;
}

export function applyOtOp(state, op) {
  const [kind, key, arg] = op;
  if (kind === "set") state.set(key, arg);
  else if (kind === "del") state.delete(key);
  else if (kind === "patch") {
    const cur = state.get(key);
    if (cur !== undefined) state.set(key, { ...cur, ...arg });
  }
}

export class OtServer {
  /**
   * @param {{ snapshotEvery?: number, maxLogOps?: number }} [options]
   *   snapshotEvery: fold the log into a snapshot every N sequenced ops.
   *   maxLogOps: hard cap on retained log; slower clients get a snapshot.
   */
  constructor({ snapshotEvery = 1000, maxLogOps = 5000 } = {}) {
    this.snapshotEvery = snapshotEvery;
    this.maxLogOps = maxLogOps;
    this.state = new Map();
    this.rev = 0;
    this.log = []; // [{ rev, client, op }]
    this.logBase = 0; // rev of the op before log[0]
    this.acked = new Map(); // client → last rev it has seen
    this.snapshot = { rev: 0, entries: [] };
    this.sinceSnapshot = 0;
    this.snapshotsTaken = 0;
  }

  #opsSince(rev) {
    return rev < this.logBase ? null : this.log.slice(rev - this.logBase);
  }

  /**
   * What a client at `rev` needs: the ops after it, or the snapshot when the
   * log no longer reaches back *or* replaying would ship more ops than the
   * snapshot has entries (long-offline clients).
   */
  catchUp(rev) {
    const ops = this.#opsSince(rev);
    if (!ops || ops.length > this.state.size)
      return { type: "snapshot", rev: this.rev, entries: [...this.state] };
    return { type: "ops", rev: this.rev, ops };
  }

  /** Sequences a batch from `client` based on `baseRev`. */
  submit(client, baseRev, ops) {
    const catchUp = this.catchUp(baseRev);
    const since = this.#opsSince(baseRev);
    const concurrent = since ? since.map((e) => e.op) : null;
    const accepted = [];
    for (let op of ops) {
      if (concurrent) for (const c of concurrent) op = op && transformOp(op, c);
      else if (op[0] === "patch" && !this.state.has(op[1])) op = null;
      if (!op) continue;
      applyOtOp(this.state, op);
      this.log.push({ rev: ++this.rev, client, op });
      accepted.push(op);
    }
    this.acked.set(client, this.rev);
    this.sinceSnapshot += accepted.length;
    if (this.sinceSnapshot >= this.snapshotEvery) this.compact();
    return { catchUp, rev: this.rev, accepted };
  }

  /**
   * Folds the log into a snapshot and truncates it to what the slowest
   * *recently acked* client still needs, bounded by `maxLogOps`.
   */
  compact() {
    this.snapshot = { rev: this.rev, entries: [...this.state] };
    this.sinceSnapshot = 0;
    this.snapshotsTaken++;
    const minAck = Math.min(this.rev, ...this.acked.values());
    const keepFrom = Math.max(minAck, this.rev - this.maxLogOps);
    const drop = keepFrom - this.logBase;
    if (drop > 0) {
      this.log = this.log.slice(drop);
      this.logBase = keepFrom;
    }
  }

  stats() {
    return { entries: this.state.size, logOps: this.log.length, rev: this.rev, snapshots: this.snapshotsTaken };
  }
}

export class OtClient {
  constructor(clientId) {
    this.clientId = clientId;
    this.confirmed = new Map();
    this.view = new Map();
    this.rev = 0;
    this.pending = [];
  }

  apply(op) {
    this.pending.push(op);
    applyOtOp(this.view, op);
  }

  set(key, value) {
    this.apply(["set", key, value]);
  }

  delete(key) {
    this.apply(["del", key]);
  }

  patch(key, fields) {
    this.apply(["patch", key, fields]);
  }

  /**
   * Coalesces the offline queue: later set/del on a key supersede earlier
   * ops on it; consecutive patches merge. Returns number of ops purged.
   */
  compactPending() {
    const before = this.pending.length;
    const out = [];
    const lastIdx = new Map();
    for (const op of this.pending) {
      const [kind, key, arg] = op;
      const idx = lastIdx.get(key);
      if (idx !== undefined && (kind === "set" || kind === "del")) {
        out[idx] = null;
      } else if (idx !== undefined && kind === "patch" && out[idx]) {
        const prev = out[idx];
        if (prev[0] === "set") {
          out[idx] = ["set", key, { ...prev[2], ...arg }];
          continue;
        }
        if (prev[0] === "patch") {
          out[idx] = ["patch", key, { ...prev[2], ...arg }];
          continue;
        }
      }
      lastIdx.set(key, out.length);
      out.push(op);
    }
    this.pending = out.filter(Boolean);
    return before - this.pending.length;
  }

  /** Round-trip with the sequencer. Returns bytes moved each way. */
  sync(server) {
    const outbound = { baseRev: this.rev, ops: this.pending };
    const res = server.submit(this.clientId, this.rev, this.pending);
    const inbound = { catchUp: res.catchUp, rev: res.rev, accepted: res.accepted.length };
    if (res.catchUp.type === "snapshot") this.confirmed = new Map(res.catchUp.entries);
    else for (const e of res.catchUp.ops) applyOtOp(this.confirmed, e.op);
    for (const op of res.accepted) applyOtOp(this.confirmed, op);
    this.rev = res.rev;
    this.pending = [];
    this.view = new Map(this.confirmed);
    return { upBytes: wireSize(outbound), downBytes: wireSize(inbound) };
  }
}

/**
 * Actionable-first, paged, resumable hydration protocol (ISP-066, #930–#932).
 *
 * 1. Fetches the actionable slice (today's open dispatches, <1MB) first.
 * 2. Resumes from a valid checkpoint, or cold-starts from the base snapshot.
 * 3. Pages deltas (500 ops per page). Each page is checksum-verified, deduped
 *    by operation identity, applied, and committed together with its vector.
 * 4. On completion, emits a join receipt and verifies it against the server.
 *
 * Integrity rules:
 * - A snapshot or page whose checksum does not match is rejected before any op
 *   is applied, and the checkpoint is not advanced (HydrationIntegrityError).
 * - A checkpoint that is not a valid vector, or cannot be read, is discarded
 *   and the device cold-starts from the snapshot.
 * - Paging that stops advancing is an error, never an infinite loop.
 *
 * Durability: pass `opsLog` (a HydrationStore) to make resume exact. Each page's
 * ops and its checkpoint vector are committed in one transaction, and a resume
 * replays the log before fetching the remaining pages. Without `opsLog`, the
 * checkpoint is written through `storage` alone, and the caller must keep the
 * applied state durable itself.
 */

const CHECKPOINT_KEY = 'crdt_resume_vector';

export class HydrationIntegrityError extends Error {
  constructor(reason, detail = {}) {
    super(`Hydration integrity check failed: ${reason}`);
    this.name = 'HydrationIntegrityError';
    this.reason = reason;
    this.detail = detail;
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// The server hashes JSON.stringify(ops). Re-stringifying the parsed array yields
// the same bytes, so the client recomputes exactly what the server hashed.
async function verifyChecksum(ops, expected, kind) {
  const actual = await sha256Hex(JSON.stringify(ops));
  if (typeof expected !== 'string' || actual !== expected) {
    throw new HydrationIntegrityError(`${kind}_checksum_mismatch`, { expected, actual });
  }
}

function assertWellFormed(ops, kind) {
  for (const op of ops) {
    if (!op || typeof op.actor !== 'string' || !Number.isSafeInteger(op.counter) || op.counter < 1) {
      throw new HydrationIntegrityError(`${kind}_malformed_op`);
    }
  }
}

/** Drops operations already seen in this run or replayed from the log. */
function takeFresh(ops, seen, stats) {
  const fresh = [];
  for (const op of ops) {
    const id = opIdentity(op);
    if (seen.has(id)) {
      stats.duplicatesSkipped++;
      continue;
    }
    seen.add(id);
    fresh.push(op);
  }
  return fresh;
}

function applyOps(doc, ops) {
  if (!doc || ops.length === 0) return;
  if (typeof doc.merge === 'function') doc.merge(ops);
  else if (typeof doc.applyUpdate === 'function') doc.applyUpdate({ type: 'delta', ops });
}

/**
 * Lifts the doc's own clock to the server vector so a new local write never
 * reuses a counter the server already holds. Compacted snapshots omit
 * superseded ops, so the doc's clock can otherwise lag behind the vector.
 */
function raiseLocalClock(doc, vector) {
  if (!doc || !doc.clock || typeof doc.clock !== 'object') return;
  for (const [key, counter] of Object.entries(vector)) {
    doc.clock[key] = Math.max(doc.clock[key] ?? 0, counter);
  }
}

async function readCheckpoint(storage) {
  if (!storage || typeof storage.getItem !== 'function') return { status: 'absent' };
  let raw;
  try {
    raw = await storage.getItem(CHECKPOINT_KEY);
  } catch {
    return { status: 'corrupt', reason: 'checkpoint_unreadable' };
  }
  if (raw === null || raw === undefined) return { status: 'absent' };
  try {
    const parsed = JSON.parse(raw);
    if (isValidVector(parsed)) return { status: 'valid', vector: parsed };
  } catch {
    // Malformed JSON falls through to the corrupt result below.
  }
  return { status: 'corrupt', reason: 'checkpoint_malformed' };
}

async function commitPage({ storage, opsLog, ops, vector }) {
  const value = JSON.stringify(vector);
  if (opsLog && typeof opsLog.commitPage === 'function') {
    await opsLog.commitPage(ops, CHECKPOINT_KEY, value);
    return;
  }
  if (storage && typeof storage.setItem === 'function') {
    await storage.setItem(CHECKPOINT_KEY, value);
  }
}

async function resetCheckpoint(storage, opsLog) {
  if (opsLog && typeof opsLog.clearOps === 'function') await opsLog.clearOps();
  if (storage && typeof storage.removeItem === 'function') await storage.removeItem(CHECKPOINT_KEY);
}

async function verifyReceiptAgainstServer(receipt, { apiBase, fetcher, abortSignal }) {
  try {
    const res = await fetcher(`${apiBase}/sync/digest`, { signal: abortSignal });
    if (!res.ok) return { complete: false, reason: 'digest_unavailable' };
    const expected = await res.json();
    if (!Number.isFinite(expected?.highwater) || typeof expected?.hash !== 'string') {
      return { complete: false, reason: 'digest_malformed' };
    }
    return verifyJoinCompleteness(receipt, { highwater: expected.highwater, hash: expected.hash });
  } catch {
    return { complete: false, reason: 'digest_unavailable' };
  }
}

export async function hydratePaged({
  doc,
  apiBase = '/api',
  fetcher = globalThis.fetch,
  pageSize = 500,
  storage = null,
  opsLog = null,
  onProgress = () => {},
  abortSignal = null,
  verifyReceipt = true,
  requestPersistence = requestPersistentStorage,
  onPersistence = () => {},
} = {}) {
  const startedAt = now();
  // #895: joining an incident is the moment its offline data starts to
  // matter, so ask (once per origin) for storage the browser will not evict.
  // Never awaited on the hot path and never fatal: a denied request still
  // lets the join proceed on best-effort storage.
  if (typeof requestPersistence === 'function') {
    Promise.resolve()
      .then(() => requestPersistence({ trigger: 'incident-join' }))
      .then((state) => onPersistence(state))
      .catch(() => {});
  }
  const stats = { totalFetched: 0, duplicatesSkipped: 0, discardedOps: 0 };
  const seen = new Set();
  let actionableItems = [];
  let timeToActionableMs = null;
  let snapshotId = null;

  // Phase 1: actionable slice first. Non-fatal if it fails.
  onProgress({ phase: 'actionable', percent: 10, message: 'Fetching open dispatches' });
  try {
    const actRes = await fetcher(`${apiBase}/dispatch?slice=open-today`, { signal: abortSignal });
    if (actRes.ok) {
      actionableItems = await actRes.json();
      timeToActionableMs = now() - startedAt;
      onProgress({
        phase: 'actionable_ready',
        percent: 25,
        actionableCount: actionableItems.length,
        timeToActionableMs,
      });
    }
  } catch {
    // Non-fatal fallback for the actionable slice.
  }

  // Phase 2: decide between resuming and a cold start.
  let currentVector = {};
  let resumed = false;
  const checkpoint = await readCheckpoint(storage);
  if (checkpoint.status === 'valid') {
    currentVector = checkpoint.vector;
    try {
      if (opsLog && typeof opsLog.replay === 'function') {
        await opsLog.replay((ops) => applyOps(doc, takeFresh(ops, seen, stats)));
      }
      resumed = true;
    } catch {
      // The log cannot be replayed, so the checkpoint would claim data we do not
      // have. Fall through to a cold start.
    }
    if (!resumed) {
      onProgress({ phase: 'checkpoint_reset', reason: 'checkpoint_unusable' });
      seen.clear();
      await resetCheckpoint(storage, opsLog);
      currentVector = {};
    }
  } else if (checkpoint.status === 'corrupt') {
    onProgress({ phase: 'checkpoint_reset', reason: checkpoint.reason });
    await resetCheckpoint(storage, opsLog);
  }

  if (resumed) {
    raiseLocalClock(doc, currentVector);
    onProgress({ phase: 'resume', percent: 35, vector: currentVector, message: 'Resuming from checkpoint' });
  } else {
    // Phase 2b: cold start from the compacted base snapshot.
    onProgress({ phase: 'snapshot', percent: 35, message: 'Downloading base snapshot' });
    try {
      const snapRes = await fetcher(`${apiBase}/sync/snapshot`, { signal: abortSignal });
      if (snapRes.ok) {
        const snap = await snapRes.json();
        const ops = Array.isArray(snap.operations) ? snap.operations : [];
        await verifyChecksum(ops, snap.checksum, 'snapshot');
        assertWellFormed(ops, 'snapshot');
        if (!isValidVector(snap.vector)) throw new HydrationIntegrityError('snapshot_vector_invalid');
        for (const op of ops) {
          if (op.counter > (snap.vector[op.actor] ?? 0)) {
            throw new HydrationIntegrityError('snapshot_exceeds_vector', { actor: op.actor });
          }
        }
        const fresh = takeFresh(ops, seen, stats);
        applyOps(doc, fresh);
        currentVector = { ...snap.vector };
        raiseLocalClock(doc, currentVector);
        snapshotId = snap.snapshot_id ?? null;
        await commitPage({ storage, opsLog, ops: fresh, vector: currentVector });
      }
    } catch (err) {
      if (err instanceof HydrationIntegrityError) throw err;
      // Base snapshot unavailable: page the deltas from an empty vector instead.
    }
  }

  // Phase 3: paged deltas, one checkpointed page at a time.
  let hasMore = true;
  let pagesApplied = 0;
  let totalOps = 0;

  while (hasMore) {
    if (abortSignal?.aborted) throw new Error('Hydration aborted by user');
    const vectorParam = encodeURIComponent(JSON.stringify(currentVector));
    const url = `${apiBase}/sync/deltas?since_vector=${vectorParam}&limit=${pageSize}`;
    const res = await fetcher(url, { signal: abortSignal });
    if (!res.ok) throw new Error(`Failed to fetch deltas: HTTP ${res.status}`);

    const data = await res.json();
    const pageOps = Array.isArray(data.operations)
      ? data.operations
      : Array.isArray(data.deltas)
        ? data.deltas
        : [];
    stats.totalFetched += pageOps.length;

    try {
      await verifyChecksum(pageOps, data.checksum, 'delta');
      assertWellFormed(pageOps, 'delta');
      if (!isValidVector(data.next_vector)) throw new HydrationIntegrityError('delta_vector_invalid');
    } catch (err) {
      stats.discardedOps += pageOps.length;
      throw err;
    }

    hasMore = Boolean(data.has_more);
    if (pageOps.length === 0) {
      if (hasMore) throw new HydrationIntegrityError('paging_stalled', { vector: currentVector });
      break;
    }
    if (!vectorAdvances(data.next_vector, currentVector)) {
      throw new HydrationIntegrityError('paging_stalled', { vector: currentVector });
    }

    const fresh = takeFresh(pageOps, seen, stats);
    applyOps(doc, fresh);
    currentVector = { ...data.next_vector };
    raiseLocalClock(doc, currentVector);
    await commitPage({ storage, opsLog, ops: fresh, vector: currentVector });

    pagesApplied++;
    totalOps += fresh.length;
    onProgress({
      phase: 'deltas',
      percent: Math.min(99, 40 + pagesApplied * 10),
      pagesApplied,
      totalOps,
      hasMore,
    });
  }

  // Phase 4: join receipt, verified against the server's digest.
  const stateHash = doc && typeof doc.values === 'function' ? stateDigest(new Map(doc.values())) : null;
  const receipt = createJoinReceipt({
    snapshotId,
    highwater: sumVector(currentVector),
    pageCount: pagesApplied,
    hash: stateHash,
    clientVector: currentVector,
  });
  const receiptVerification = verifyReceipt
    ? await verifyReceiptAgainstServer(receipt, { apiBase, fetcher, abortSignal })
    : null;
  onProgress({ phase: 'join_receipt', percent: 99, receipt, verification: receiptVerification });

  const reworkOps = stats.duplicatesSkipped + stats.discardedOps;
  const reworkRatio = stats.totalFetched === 0 ? 0 : reworkOps / stats.totalFetched;
  const elapsedMs = now() - startedAt;
  onProgress({ phase: 'complete', percent: 100, totalOps, pagesApplied, reworkRatio, elapsedMs });

  return {
    actionable: actionableItems,
    pagesApplied,
    totalOps,
    vector: currentVector,
    resumed,
    receipt,
    receiptVerification,
    duplicatesSkipped: stats.duplicatesSkipped,
    reworkRatio,
    timeToActionableMs,
    elapsedMs,
  };
}
