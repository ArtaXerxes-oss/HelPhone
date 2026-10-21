// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  OtClient,
  OtServer,
  StateVectorDoc,
  applyOtOp,
  stableStateVector,
  stateDigest,
  syncPair,
  transformOp,
} from "../src/services/crdtSync.js";

// ---------------------------------------------------------------------------
// Off-grid map sync spike (#604): state-vector CRDT with causal-stability
// pruning, and light OT with sequencer snapshots. The fuzz tests check that
// pruning never changes the converged state — replicas must match an oracle
// computed from every op ever issued (LWW by (lamport, client)).
// ---------------------------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const deliver = (from, to) => to.applyUpdate(from.encodeUpdate(to.stateVector()));

function fullSync(replicas) {
  for (let round = 0; round < 6; round++)
    for (const a of replicas) for (const b of replicas) if (a !== b) syncPair(a, b);
}

function oracle(ops) {
  const winners = new Map();
  for (const op of ops) {
    const cur = winners.get(op.key);
    if (!cur || op.lamport > cur.lamport || (op.lamport === cur.lamport && op.client > cur.client))
      winners.set(op.key, op);
  }
  const visible = new Map();
  for (const [k, op] of winners) if (!op.deleted) visible.set(k, op.value);
  return visible;
}

describe("StateVectorDoc basics", () => {
  it("converges concurrent writes by (lamport, client)", () => {
    const a = new StateVectorDoc("a");
    const b = new StateVectorDoc("b");
    a.set("k", 1);
    b.set("k", 2); // same lamport, client "b" > "a"
    syncPair(a, b);
    expect(a.get("k")).toBe(2);
    expect(b.get("k")).toBe(2);
    a.set("k", 3); // a now has a higher lamport
    syncPair(a, b);
    expect(b.get("k")).toBe(3);
  });

  it("ships only ops missing from the peer's state vector", () => {
    const a = new StateVectorDoc("a");
    const b = new StateVectorDoc("b");
    for (let i = 0; i < 10; i++) a.set(`k${i}`, i);
    deliver(a, b);
    a.set("k0", "x");
    const update = a.encodeUpdate(b.stateVector());
    expect(update.type).toBe("delta");
    expect(update.ops).toHaveLength(1);
  });

  it("buffers out-of-order ops until the gap is filled", () => {
    const a = new StateVectorDoc("a");
    const b = new StateVectorDoc("b");
    a.set("x", 1);
    a.set("y", 2);
    const [first, second] = a.encodeUpdate({}).ops;
    b.applyUpdate({ type: "delta", ops: [second] });
    expect(b.get("y")).toBeUndefined();
    b.applyUpdate({ type: "delta", ops: [first] });
    expect(b.get("x")).toBe(1);
    expect(b.get("y")).toBe(2);
  });

  it("drops superseded values when gcContent is on, keeping their ids", () => {
    const a = new StateVectorDoc("a");
    a.set("k", { big: "x".repeat(100) });
    a.set("k", 2);
    expect(a.stats()).toMatchObject({ logOps: 2, tombstones: 1 });
    expect(a.log.get("a")[0].value).toBeNull();
    const keep = new StateVectorDoc("a", { gcContent: false });
    keep.set("k", 1);
    keep.set("k", 2);
    expect(keep.log.get("a")[0].value).toBe(1);
  });
});

describe("causal-stability pruning", () => {
  it("drops the whole log once every peer has it", () => {
    const docs = ["a", "b", "c"].map((id) => new StateVectorDoc(id));
    docs.forEach((d, i) => {
      for (let n = 0; n < 50; n++) d.set(`k${n % 5}`, `${i}:${n}`);
    });
    fullSync(docs);
    const stable = stableStateVector(docs.map((d) => d.stateVector()));
    for (const d of docs) d.prune(stable);
    for (const d of docs) expect(d.stats()).toMatchObject({ logOps: 0, tombstones: 0 });
    expect(new Set(docs.map((d) => stateDigest(d.toMap()))).size).toBe(1);
  });

  it("serves a snapshot to a peer behind the pruned frontier, filtered to what it lacks", () => {
    const a = new StateVectorDoc("a");
    const b = new StateVectorDoc("b");
    for (let n = 0; n < 20; n++) a.set(`k${n}`, n);
    deliver(a, b);
    for (let n = 0; n < 5; n++) a.set(`k${n}`, n + 100);
    a.prune(a.stateVector()); // pretend b was evicted from membership
    const update = a.encodeUpdate(b.stateVector());
    expect(update.type).toBe("snapshot");
    expect(update.entries).toHaveLength(5);
    b.applyUpdate(update);
    expect(stateDigest(b.toMap())).toBe(stateDigest(a.toMap()));
  });

  it("keeps a delete tombstone while an older concurrent write is still in flight", () => {
    // Regression: dropping a causally-stable delete let a lower-Lamport set
    // that some replicas had not yet received resurrect the key only there.
    const a = new StateVectorDoc("a");
    const b = new StateVectorDoc("b");
    const c = new StateVectorDoc("c");
    a.set("k", 1);
    deliver(a, b);
    deliver(a, c);
    b.set("k", 2); // lamport 2, not yet sent anywhere
    a.set("other", 0);
    a.delete("k"); // lamport 3: wins over b's write under LWW
    deliver(a, b);
    deliver(a, c);
    deliver(b, a); // a has b's write; c does not
    const stable = stableStateVector([a, b, c].map((d) => d.stateVector()));
    expect(stable.a).toBe(3); // the delete is causally stable…
    for (const d of [a, b, c]) d.prune(stable);
    expect(c.stats().deleteTombstones).toBe(1); // …but must survive pruning
    fullSync([a, b, c]);
    for (const d of [a, b, c]) expect(d.get("k")).toBeUndefined();
  });

  it("releases the tombstone once nothing older can arrive", () => {
    const a = new StateVectorDoc("a");
    const b = new StateVectorDoc("b");
    a.set("k", 1);
    a.delete("k");
    syncPair(a, b);
    b.set("x", 1);
    syncPair(a, b);
    const stable = stableStateVector([a, b].map((d) => d.stateVector()));
    a.prune(stable, ["a", "b"]);
    expect(a.stats().deleteTombstones).toBe(0);
  });

  it("keeps a tombstone until an evicted device has seen it", () => {
    // Regression: pruning at the live members' frontier dropped a delete the
    // offline device never received, so it came back with its stale value.
    const a = new StateVectorDoc("a");
    const b = new StateVectorDoc("b");
    const x = new StateVectorDoc("x");
    x.set("k", 1);
    deliver(x, a);
    deliver(x, b);
    a.delete("k"); // lamport 2 — x goes offline and never sees it
    for (let i = 0; i < 5; i++) x.set("z", i); // x's lamport runs ahead
    deliver(x, a);
    deliver(x, b);
    deliver(a, b);
    b.set("q", 1);
    deliver(b, a);
    const roster = ["a", "b", "x"];
    const live = stableStateVector([a, b].map((d) => d.stateVector()));
    const everyone = stableStateVector([a, b, x].map((d) => d.stateVector()));
    for (const d of [a, b]) d.prune(live, roster, everyone);
    expect(a.stats().deleteTombstones).toBe(1);
    expect(a.encodeUpdate(x.stateVector()).type).toBe("snapshot"); // x is behind the log frontier
    fullSync([a, b, x]);
    for (const d of [a, b, x]) expect(d.get("k")).toBeUndefined();
  });

  it("pins tombstones for roster members that have never written", () => {
    const a = new StateVectorDoc("a");
    a.set("k", 1);
    a.delete("k");
    a.prune(a.stateVector(), ["a", "silent-device"]);
    expect(a.stats().deleteTombstones).toBe(1);
    a.prune(a.stateVector(), ["a"]);
    expect(a.stats().deleteTombstones).toBe(0);
  });

  for (const mode of ["all", "subset"]) {
    it(`never changes the converged state (fuzz, prune ${mode})`, () => {
      for (let seed = 1; seed <= 30; seed++) {
        const rand = rng(seed);
        const ids = ["r0", "r1", "r2", "r3"];
        const docs = ids.map((id) => new StateVectorDoc(id));
        const issued = [];
        for (let step = 0; step < 300; step++) {
          const roll = rand();
          const d = docs[Math.floor(rand() * docs.length)];
          if (roll < 0.5) {
            issued.push(d.set(`k${Math.floor(rand() * 6)}`, step));
          } else if (roll < 0.6) {
            issued.push(d.delete(`k${Math.floor(rand() * 6)}`));
          } else if (roll < 0.9) {
            const other = docs[Math.floor(rand() * docs.length)];
            if (other !== d) deliver(d, other);
          } else {
            // "subset": evict offline members from log pruning, but gate
            // tombstones on the whole roster's (last known) state vectors.
            const members = mode === "all" ? docs : docs.filter(() => rand() < 0.6);
            if (!members.length) continue;
            const stable = stableStateVector(members.map((m) => m.stateVector()));
            const everyone = stableStateVector(docs.map((m) => m.stateVector()));
            for (const m of members) m.prune(stable, ids, everyone);
          }
        }
        fullSync(docs);
        const expected = stateDigest(oracle(issued));
        for (const d of docs) expect(stateDigest(d.toMap()), `seed ${seed}`).toBe(expected);
      }
    });
  }
});

describe("light OT", () => {
  it("drops a patch whose entity was concurrently deleted", () => {
    expect(transformOp(["patch", "i:1", { s: 1 }], ["del", "i:1"])).toBeNull();
    expect(transformOp(["patch", "i:1", { s: 1 }], ["del", "i:2"])).toEqual(["patch", "i:1", { s: 1 }]);
    expect(transformOp(["set", "i:1", 1], ["del", "i:1"])).toEqual(["set", "i:1", 1]);
  });

  it("applies patches as field merges and ignores missing keys", () => {
    const state = new Map([["i:1", { status: "open", sev: 2 }]]);
    applyOtOp(state, ["patch", "i:1", { status: "on_scene" }]);
    applyOtOp(state, ["patch", "i:9", { status: "x" }]);
    expect(state.get("i:1")).toEqual({ status: "on_scene", sev: 2 });
    expect(state.has("i:9")).toBe(false);
  });

  it("converges concurrent clients through the sequencer", () => {
    const server = new OtServer();
    const a = new OtClient("a");
    const b = new OtClient("b");
    a.set("i:1", { status: "open" });
    a.sync(server);
    b.sync(server);
    a.delete("i:1");
    b.patch("i:1", { status: "en_route" });
    a.sync(server);
    b.sync(server);
    a.sync(server);
    expect(server.state.has("i:1")).toBe(false);
    expect(stateDigest(a.view)).toBe(stateDigest(server.state));
    expect(stateDigest(b.view)).toBe(stateDigest(server.state));
  });

  it("compacts its log and falls back to a snapshot for stale clients", () => {
    const server = new OtServer({ snapshotEvery: 10, maxLogOps: 20 });
    const writer = new OtClient("w");
    const stale = new OtClient("s");
    stale.sync(server);
    for (let i = 0; i < 100; i++) {
      writer.set(`r:${i % 5}`, i);
      writer.sync(server);
    }
    expect(server.log.length).toBeLessThanOrEqual(20);
    expect(server.catchUp(0).type).toBe("snapshot");
    stale.sync(server);
    expect(stateDigest(stale.view)).toBe(stateDigest(server.state));
  });

  it("prefers the snapshot when replaying would ship more ops than entries", () => {
    const server = new OtServer({ snapshotEvery: 1e9, maxLogOps: 1e9 });
    const w = new OtClient("w");
    for (let i = 0; i < 50; i++) w.set("only-key", i);
    w.sync(server);
    expect(server.catchUp(0).type).toBe("snapshot");
    expect(server.catchUp(server.rev - 1).type).toBe("ops");
  });

  it("coalesces an offline queue before reconnecting", () => {
    const c = new OtClient("c");
    c.set("r:1", { lat: 1 });
    c.set("r:1", { lat: 2 });
    c.patch("r:1", { acc: 5 });
    c.set("i:1", { status: "open" });
    c.patch("i:2", { status: "a" });
    c.patch("i:2", { sev: 3 });
    c.set("i:3", 1);
    c.delete("i:3");
    const purged = c.compactPending();
    expect(purged).toBe(4);
    expect(c.pending).toEqual([
      ["set", "r:1", { lat: 2, acc: 5 }],
      ["set", "i:1", { status: "open" }],
      ["patch", "i:2", { status: "a", sev: 3 }],
      ["del", "i:3"],
    ]);
  });

  it("converges randomly interleaved clients (fuzz)", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rand = rng(seed);
      const server = new OtServer({ snapshotEvery: 15, maxLogOps: 30 });
      const clients = ["a", "b", "c"].map((id) => new OtClient(id));
      for (let step = 0; step < 300; step++) {
        const c = clients[Math.floor(rand() * clients.length)];
        const roll = rand();
        const key = `k${Math.floor(rand() * 5)}`;
        if (roll < 0.4) c.set(key, { v: step });
        else if (roll < 0.6) c.patch(key, { p: step });
        else if (roll < 0.7) c.delete(key);
        else {
          if (rand() < 0.5) c.compactPending();
          c.sync(server);
        }
      }
      for (const c of clients) c.sync(server);
      for (const c of clients) c.sync(server);
      for (const c of clients) expect(stateDigest(c.view), `seed ${seed}`).toBe(stateDigest(server.state));
    }
  });
});
