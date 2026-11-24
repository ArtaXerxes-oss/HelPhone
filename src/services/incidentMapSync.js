/**
 * Incident map replica: pruned state-vector CRDT sync over gossip (#894).
 *
 * Wraps the spike's `StateVectorDoc` (ADR-004) with what a real off-grid mesh
 * needs and the prototype read directly from other replicas:
 *
 *  - **Roster in the document.** Each device is a `__roster/<clientId>` key.
 *    Joining sets it; `removeFromRoster(id)` deletes it, and the delete
 *    propagates like any other op. A removed device's gossip is refused from
 *    then on (a lost device that returns must rejoin under a new id).
 *  - **Roster state vectors in gossip.** Every message carries the sender's
 *    state vector and the last state vector it knows for every other roster
 *    member. Vectors only grow, so merging by element-wise maximum keeps each
 *    entry a valid lower bound of what that member has seen.
 *  - **Pruning from known vectors.** The op log is pruned to what every peer
 *    heard from within `liveWindowMs` has seen. Delete tombstones are released
 *    only once a state vector is known for every roster member, using the
 *    full-roster stable vector, so a tombstone pinned by a permanently lost
 *    device is released as soon as that device is removed from the roster.
 *  - **Binary wire.** Messages use crdtWire.js (varints + string dictionary)
 *    instead of JSON.
 *
 * Removal is for good: ops written by a removed device, even ones another
 * peer relays later, are discarded. Remove only a device known to be lost.
 *
 * A delete tombstone is released only when every remaining roster member has
 * seen it and has written something after it (ADR-004 pruning rule 2), which
 * responders do with their periodic position updates. A device that is on
 * the roster but silent keeps tombstones pinned until it writes or is removed.
 */

import { StateVectorDoc, stableStateVector } from "./crdtSync.js";
import { decodeGossip, encodeGossip } from "../lib/crdtWire.js";

export const ROSTER_PREFIX = "__roster/";
const isRosterKey = (k) => k.startsWith(ROSTER_PREFIX);

function maxVector(a = {}, b = {}) {
  const out = { ...a };
  for (const [c, n] of Object.entries(b)) if (!(out[c] >= n)) out[c] = n;
  return out;
}

export class IncidentMapReplica {
  /**
   * @param {string} clientId this device's replica id
   * @param {object} [options]
   * @param {number} [options.liveWindowMs=60000] peers heard from within this
   *   window bound log pruning
   * @param {() => number} [options.now]
   */
  constructor(clientId, { liveWindowMs = 60_000, now = () => Date.now(), gcContent = true } = {}) {
    if (typeof clientId !== "string" || !clientId || isRosterKey(clientId)) throw new RangeError("Invalid clientId");
    this.clientId = clientId;
    this.doc = new StateVectorDoc(clientId, { gcContent });
    this.liveWindowMs = liveWindowMs;
    this.now = now;
    /** member → last known state vector (lower bound) */
    this.known = new Map();
    /** member → time we last heard from it directly */
    this.lastHeard = new Map();
    this.metrics = { sentBytes: 0, receivedBytes: 0, refused: 0, prunes: 0, droppedOps: 0, droppedTombstones: 0 };
    /**
     * Ids removed from the roster for good. Kept outside the document because
     * the roster delete is itself a tombstone and is eventually pruned.
     */
    this.retiredIds = new Set();
    this.doc.set(ROSTER_PREFIX + clientId, { joinedAt: now() });
  }

  // ── Map API ───────────────────────────────────────────────────────────────

  set(key, value) {
    if (isRosterKey(key)) throw new RangeError("Roster keys are managed by the replica");
    return this.doc.set(key, value);
  }

  delete(key) {
    if (isRosterKey(key)) throw new RangeError("Use removeFromRoster() for roster keys");
    return this.doc.delete(key);
  }

  get(key) {
    return this.doc.get(key);
  }

  /** Visible incident-map entries, roster keys excluded. */
  entries() {
    const out = new Map();
    for (const [k, v] of this.doc.toMap()) if (!isRosterKey(k)) out.set(k, v);
    return out;
  }

  roster() {
    const out = [];
    for (const k of this.doc.toMap().keys()) if (isRosterKey(k)) out.push(k.slice(ROSTER_PREFIX.length));
    return out.sort();
  }

  isMember(id) {
    return this.doc.get(ROSTER_PREFIX + id) !== undefined;
  }

  /**
   * Permanently removes a lost device from the roster. Its tombstone pins are
   * released at the next prune; its future gossip is refused.
   */
  removeFromRoster(id) {
    if (id === this.clientId) throw new RangeError("A replica cannot remove itself");
    if (!this.isMember(id)) return false;
    this.doc.delete(ROSTER_PREFIX + id);
    this.retiredIds.add(id);
    this.known.delete(id);
    this.lastHeard.delete(id);
    this.prune();
    return true;
  }

  // ── Gossip ────────────────────────────────────────────────────────────────

  /** Roster state vectors to relay: every member's best known vector. */
  #rosterVectors() {
    const out = {};
    for (const id of this.roster()) {
      if (id === this.clientId) continue;
      const sv = this.known.get(id);
      if (sv) out[id] = sv;
    }
    return out;
  }

  /** A binary gossip message for `peerId` (or a full catch-up when unknown). */
  gossipFor(peerId) {
    const peerSV = (peerId && this.known.get(peerId)) || {};
    const bytes = encodeGossip({
      from: this.clientId,
      sv: this.doc.stateVector(),
      roster: this.#rosterVectors(),
      update: this.doc.encodeUpdate(peerSV),
    });
    this.metrics.sentBytes += bytes.byteLength;
    return bytes;
  }

  /**
   * Integrates a gossip message. Returns { applied, from } or
   * { refused: true, from } for a sender that is no longer on the roster.
   */
  receive(bytes) {
    const msg = decodeGossip(bytes);
    this.metrics.receivedBytes += bytes.byteLength;
    const removed = this.#wasRemoved(msg.from);
    if (msg.from === this.clientId || removed) {
      if (removed) this.metrics.refused++;
      return { refused: removed, from: msg.from, applied: 0 };
    }
    const applied = this.doc.applyUpdate(this.#withoutRetired(msg.update));
    this.#recordRetired();
    this.known.set(msg.from, maxVector(this.known.get(msg.from), msg.sv));
    this.lastHeard.set(msg.from, this.now());
    for (const [member, sv] of Object.entries(msg.roster)) {
      if (member === this.clientId || !this.isMember(member) || this.retiredIds.has(member)) continue;
      this.known.set(member, maxVector(this.known.get(member), sv));
    }
    this.prune();
    return { applied, from: msg.from };
  }

  /** Clients removed from the roster for good. */
  retired() {
    this.#recordRetired();
    return [...this.retiredIds].sort();
  }

  /** Remembers every roster delete before pruning can release it. */
  #recordRetired() {
    for (const [k, e] of this.doc.entries)
      if (isRosterKey(k) && e.deleted) this.retiredIds.add(k.slice(ROSTER_PREFIX.length));
  }

  /**
   * Drops ops written by retired clients, including ops relayed by other
   * peers. Removal is for good: an op the lost device still had in flight is
   * discarded rather than allowed to outrank a tombstone already released.
   */
  #withoutRetired(update) {
    const retired = new Set(this.retired());
    if (!retired.size) return update;
    if (update.type === "delta") return { ...update, ops: update.ops.filter((o) => !retired.has(o[3])) };
    return { ...update, entries: update.entries.filter((e) => !retired.has(e[3])) };
  }

  /** A sender that has been removed from the roster. */
  #wasRemoved(id) {
    this.#recordRetired();
    return this.retiredIds.has(id);
  }

  // ── Pruning ───────────────────────────────────────────────────────────────

  prune() {
    const own = this.doc.stateVector();
    const roster = this.roster();
    const t = this.now();
    const live = [own];
    for (const id of roster) {
      if (id === this.clientId) continue;
      const heard = this.lastHeard.get(id);
      const sv = this.known.get(id);
      if (sv && heard !== undefined && t - heard <= this.liveWindowMs) live.push(sv);
    }
    const stable = stableStateVector(live);

    // Tombstones: only with a known vector for every roster member.
    let tombstoneSV = {};
    const all = [own];
    let complete = true;
    for (const id of roster) {
      if (id === this.clientId) continue;
      const sv = this.known.get(id);
      if (!sv) {
        complete = false;
        break;
      }
      all.push(sv);
    }
    if (complete) tombstoneSV = stableStateVector(all);
    const r = this.doc.prune(stable, roster, tombstoneSV, this.retired());
    this.metrics.prunes++;
    this.metrics.droppedOps += r.droppedOps;
    this.metrics.droppedTombstones += r.droppedTombstones;
    return r;
  }

  stats() {
    const s = this.doc.stats();
    return {
      ...s,
      rosterSize: this.roster().length,
      knownVectors: this.known.size,
      ...this.metrics,
    };
  }
}

/**
 * Connects a replica to a BroadcastChannel-like transport (postMessage +
 * onmessage), e.g. a `BroadcastChannel` between tabs or a mesh relay. Sends a
 * full gossip message on `sync()` and whenever `notify()` is called after a
 * local change; replies to new peers so they catch up.
 */
export function connectReplica(replica, channel, { onChange = () => {}, onRefused = () => {} } = {}) {
  const send = (peerId) => channel.postMessage(replica.gossipFor(peerId));
  const peers = new Set();
  const handler = (event) => {
    const data = event && event.data;
    if (!(data instanceof Uint8Array)) return;
    let result;
    try {
      result = replica.receive(data);
    } catch {
      return; // malformed gossip is ignored
    }
    if (result.refused) {
      onRefused(result.from);
      return;
    }
    if (result.from === replica.clientId) return;
    const isNewPeer = !peers.has(result.from);
    peers.add(result.from);
    if (result.applied > 0) onChange();
    // Answer a new peer (so it catches up) and anyone who just sent us news
    // (so it learns our vector). A message with nothing new ends the exchange.
    if (isNewPeer || result.applied > 0) send(result.from);
  };
  if (typeof channel.addEventListener === "function") channel.addEventListener("message", handler);
  else channel.onmessage = handler;
  return {
    sync: () => send(null),
    notify: () => send(null),
    close() {
      if (typeof channel.removeEventListener === "function") channel.removeEventListener("message", handler);
      else channel.onmessage = null;
    },
  };
}
