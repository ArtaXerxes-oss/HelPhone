// @vitest-environment node
/**
 * #894 — pruned state-vector CRDT sync for the help map: binary wire
 * encoding, roster state vectors in gossip, explicit roster removal.
 */
import { describe, expect, it } from "vitest";
import { StateVectorDoc, wireSize } from "../src/services/crdtSync.js";
import { WireFormatError, decodeGossip, decodeUpdate, encodeGossip, encodeUpdate } from "../src/lib/crdtWire.js";
import { IncidentMapReplica, ROSTER_PREFIX, connectReplica } from "../src/services/incidentMapSync.js";
import { createRng } from "../src/utils/graphTraversal.js";

const byClientClock = (ops) =>
  ops.slice().sort((a, b) => (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : a[4] - b[4]));

function randomValue(rand, i) {
  switch (i % 5) {
    case 0:
      return { lat: 6.5 + rand() * 0.01, lng: 3.38 + rand() * 0.01, status: "en-route", eta: Math.floor(rand() * 600) };
    case 1:
      return { status: ["open", "resolved", "triage"][Math.floor(rand() * 3)], count: -Math.floor(rand() * 9) };
    case 2:
      return ["needs-water", "elderly", "injured"].slice(0, 1 + (i % 3));
    case 3:
      return `note ${i} — ünïcödé ✓`;
    default:
      return i % 2 === 0;
  }
}

/** Two replicas mutate and sync; returns every update that crossed the wire. */
function recordedUpdates({ ops = 2000, keys = 60, seed = 3 } = {}) {
  const rand = createRng(seed);
  const a = new StateVectorDoc("responder-a");
  const b = new StateVectorDoc("responder-b");
  const updates = [];
  for (let i = 0; i < ops; i++) {
    const doc = rand() < 0.5 ? a : b;
    const key = `incident/${Math.floor(rand() * keys)}`;
    if (rand() < 0.08) doc.delete(key);
    else doc.set(key, randomValue(rand, i));
    if (i % 50 === 49) {
      const toB = a.encodeUpdate(b.stateVector());
      const toA = b.encodeUpdate(a.stateVector());
      updates.push(toB, toA);
      b.applyUpdate(toB);
      a.applyUpdate(toA);
    }
  }
  updates.push(a.encodeSnapshot(), b.encodeSnapshot(a.stateVector()));
  return updates;
}

describe("binary wire encoding", () => {
  it("round-trips every delta and snapshot exactly", () => {
    for (const u of recordedUpdates()) {
      const back = decodeUpdate(encodeUpdate(u));
      // Same as a JSON round trip (which also turns -0 into 0), ops in (client, clock) order.
      const json = JSON.parse(JSON.stringify(u));
      if (u.type === "delta") expect(back).toEqual({ ...json, ops: byClientClock(json.ops) });
      else expect(back).toEqual({ ...json, entries: byClientClock(json.entries) });
    }
  });

  it("gives the same replica state as applying the JSON update", () => {
    const updates = recordedUpdates({ seed: 11 });
    const viaJson = new StateVectorDoc("observer");
    const viaBinary = new StateVectorDoc("observer");
    for (const u of updates) {
      viaJson.applyUpdate(JSON.parse(JSON.stringify(u)));
      viaBinary.applyUpdate(decodeUpdate(encodeUpdate(u)));
    }
    const sorted = (m) => [...m].sort((x, y) => (x[0] < y[0] ? -1 : 1));
    expect(sorted(viaBinary.toMap())).toEqual(sorted(viaJson.toMap()));
    expect(viaBinary.stateVector()).toEqual(viaJson.stateVector());
  });

  it("preserves edge-case values", () => {
    const values = [0, -0, 1.5, -7, 2 ** 53 - 1, -(2 ** 53) + 1, 1e-300, "", "🚑", { a: [null, true, false] }, JSON.parse('{"__proto__":1}')];
    const update = { type: "delta", lamport: 9, ops: values.map((v, i) => [`k${i}`, v, 0, "c", i + 1, i + 1]) };
    const back = decodeUpdate(encodeUpdate(update));
    back.ops.forEach((op, i) => expect(JSON.stringify(op[1])).toBe(JSON.stringify(values[i])));
    // -0 travels as 0, exactly as it would through JSON.
    expect(Object.is(back.ops[1][1], 0)).toBe(true);
    expect(Object.getPrototypeOf(back.ops[10][1])).toBe(Object.prototype);
    expect(Object.keys(back.ops[10][1])).toEqual(["__proto__"]);
  });

  it("refuses malformed input instead of guessing", () => {
    const good = encodeUpdate(recordedUpdates({ ops: 200 })[0]);
    expect(() => decodeUpdate(good.slice(0, good.length - 1))).toThrow(WireFormatError);
    expect(() => decodeUpdate(Uint8Array.from([1, 2, 3, 4, 1, 1, 0]))).toThrow(/Not a HelPhone/);
    const trailing = new Uint8Array(good.length + 1);
    trailing.set(good);
    expect(() => decodeUpdate(trailing)).toThrow(/Trailing bytes/);
    expect(() => encodeUpdate({ type: "delta", lamport: 1, ops: [["k", Infinity, 0, "c", 1, 1]] })).toThrow(/Non-finite/);
  });

  it("is a fraction of the JSON size for the same gossip", () => {
    let json = 0;
    let binary = 0;
    for (const u of recordedUpdates({ ops: 5000, seed: 5 })) {
      const msg = { from: "responder-a", sv: { "responder-a": 2500, "responder-b": 2500 }, roster: { "responder-b": { "responder-a": 2400 } }, update: u };
      json += wireSize(msg);
      binary += encodeGossip(msg).byteLength;
      expect(decodeGossip(encodeGossip(msg)).from).toBe("responder-a");
    }
    // Measured ~0.37 on this workload; the bound leaves room for value mixes.
    expect(binary / json).toBeLessThan(0.5);
  });
});

describe("pruning a long incident", () => {
  it("prunes a 50k-op log in a few milliseconds", () => {
    const doc = new StateVectorDoc("commander");
    for (let i = 0; i < 50_000; i++) doc.set(`responder/${i % 300}`, { lat: 6.5, lng: 3.4, seq: i });
    expect(doc.stats().logOps).toBe(50_000);
    const t0 = performance.now();
    const r = doc.prune(doc.stateVector(), ["commander"]);
    const ms = performance.now() - t0;
    expect(r.droppedOps).toBe(50_000);
    expect(doc.stats().logOps).toBe(0);
    expect(doc.toMap().size).toBe(300);
    expect(ms).toBeLessThan(50); // ADR-004 measured ~1 ms; CI headroom
  });

  it("keeps the op log flat no matter how long the incident runs", () => {
    const a = new IncidentMapReplica("a");
    const b = new IncidentMapReplica("b");
    b.receive(a.gossipFor(null));
    a.receive(b.gossipFor("a"));
    const rand = createRng(8);
    const logSizes = [];
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 500; i++) (rand() < 0.5 ? a : b).set(`responder/${Math.floor(rand() * 200)}`, { seq: round * 500 + i });
      b.receive(a.gossipFor("b"));
      a.receive(b.gossipFor("a"));
      logSizes.push(a.stats().logOps + b.stats().logOps);
    }
    // 20,000 mutations in, the log holds about one round's worth of ops, not the history.
    expect(Math.max(...logSizes.slice(10))).toBeLessThanOrEqual(Math.max(...logSizes.slice(0, 10)) * 1.5);
    expect(a.stats().logOps).toBeLessThan(1_000);
    const sorted = (m) => [...m].sort((x, y) => (x[0] < y[0] ? -1 : 1));
    expect(sorted(a.entries())).toEqual(sorted(b.entries()));
  });
});

/** Fully connected exchange between a set of replicas until nothing changes. */
function gossipRound(replicas) {
  for (const from of replicas) for (const to of replicas) if (from !== to) to.receive(from.gossipFor(to.clientId));
}

describe("roster state vectors in gossip", () => {
  it("relays a member's vector, so A knows what C has seen without talking to C", () => {
    const [a, b, c] = ["a", "b", "c"].map((id) => new IncidentMapReplica(id));
    gossipRound([b, c]);
    c.set("incident/1", { status: "open" });
    b.receive(c.gossipFor("b"));
    a.receive(b.gossipFor(null));
    expect(a.known.get("c")).toEqual(expect.objectContaining({ c: c.doc.stateVector().c }));
    expect(a.roster()).toEqual(["a", "b", "c"]);
    expect(a.get("incident/1")).toEqual({ status: "open" });
  });
});

describe("explicit roster removal", () => {
  function incident() {
    const [a, b, c] = ["a", "b", "c"].map((id) => new IncidentMapReplica(id));
    gossipRound([a, b, c]);
    gossipRound([a, b, c]);
    for (let i = 0; i < 50; i++) a.set(`incident/${i}`, { status: "open" });
    gossipRound([a, b, c]);
    return { a, b, c };
  }

  it("pins delete tombstones while a roster device is offline", () => {
    const { a, b } = incident(); // c goes offline here
    for (let i = 0; i < 50; i++) a.delete(`incident/${i}`);
    a.set("responder/a", { lat: 6.5, lng: 3.4 });
    b.set("responder/b", { lat: 6.51, lng: 3.41 });
    for (let r = 0; r < 3; r++) gossipRound([a, b]);
    expect(a.stats().deleteTombstones).toBe(50);
    expect(b.stats().deleteTombstones).toBe(50);
  });

  it("releases a permanently lost device's tombstones once it is removed", () => {
    const { a, b, c } = incident();
    for (let i = 0; i < 50; i++) a.delete(`incident/${i}`);
    for (let r = 0; r < 3; r++) gossipRound([a, b]);

    expect(a.removeFromRoster("c")).toBe(true);
    // Live responders keep publishing their position; that is what moves
    // every remaining client past the deletes (ADR-004 condition 2).
    a.set("responder/a", { lat: 6.5, lng: 3.4 });
    b.set("responder/b", { lat: 6.51, lng: 3.41 });
    for (let r = 0; r < 3; r++) gossipRound([a, b]);
    expect(a.roster()).toEqual(["a", "b"]);
    expect(b.roster()).toEqual(["a", "b"]);
    for (const r of [a, b]) {
      const remaining = [...r.doc.entries.values()].filter((e) => e.deleted && e.key.startsWith("incident/"));
      expect(remaining).toHaveLength(0);
    }
    expect(a.stats().droppedTombstones).toBeGreaterThanOrEqual(50);

    // The lost device comes back with stale state: it is refused, and its
    // values do not resurrect the deleted incidents.
    const res = a.receive(c.gossipFor("a"));
    expect(res.refused).toBe(true);
    expect(a.get("incident/3")).toBeUndefined();
    expect(a.stats().refused).toBe(1);
  });

  it("does not let a replica remove itself or edit roster keys directly", () => {
    const a = new IncidentMapReplica("a");
    expect(() => a.removeFromRoster("a")).toThrow();
    expect(() => a.set(`${ROSTER_PREFIX}x`, {})).toThrow();
    expect(a.removeFromRoster("nobody")).toBe(false);
  });
});

describe("transport", () => {
  /** In-memory BroadcastChannel: every post reaches every other endpoint. */
  function bus() {
    const ends = new Set();
    return () => {
      const end = {
        onmessage: null,
        postMessage(data) {
          for (const other of ends) if (other !== end) queueMicrotask(() => other.onmessage && other.onmessage({ data }));
        },
      };
      ends.add(end);
      return end;
    };
  }

  it("converges three tabs over a broadcast channel", async () => {
    const open = bus();
    const replicas = ["tab-1", "tab-2", "tab-3"].map((id) => new IncidentMapReplica(id));
    const links = replicas.map((r) => connectReplica(r, open()));
    replicas[0].set("incident/fire", { status: "open" });
    replicas[2].set("responder/x", { lat: 6.5, lng: 3.4 });
    for (const l of links) l.sync();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    for (const r of replicas) {
      expect(r.get("incident/fire")).toEqual({ status: "open" });
      expect(r.get("responder/x")).toEqual({ lat: 6.5, lng: 3.4 });
      expect(r.roster()).toEqual(["tab-1", "tab-2", "tab-3"]);
    }
    for (const l of links) l.close();
  });
});
