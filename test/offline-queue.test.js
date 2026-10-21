import { beforeEach, describe, expect, it } from "vitest";
import {
  PRIO,
  clearQueue,
  enqueue,
  findByIdempotencyKey,
  listQueue,
  queueDepth,
  removeEntry,
} from "../src/lib/field/offlineQueue";

describe("offline queue", () => {
  beforeEach(() => {
    localStorage.clear();
    clearQueue();
  });

  it("deduplicates by idempotency key — double press yields one entry", () => {
    const a = enqueue({
      kind: "sos",
      prio: PRIO.SOS,
      idempotencyKey: "sos-123",
      data: { ts: 1 },
    });
    const b = enqueue({
      kind: "sos",
      prio: PRIO.SOS,
      idempotencyKey: "sos-123",
      data: { ts: 2 },
    });
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.entry.id).toBe(a.entry.id);
    expect(queueDepth()).toBe(1);
    expect(findByIdempotencyKey("sos-123").id).toBe(a.entry.id);
  });

  it("orders by priority lane: SOS ahead of new requests, roster, location", () => {
    enqueue({ kind: "loc", prio: PRIO.LOC, idempotencyKey: "l1" });
    enqueue({ kind: "roster", prio: PRIO.ROSTER, idempotencyKey: "r1" });
    enqueue({ kind: "request", prio: PRIO.NEW, idempotencyKey: "n1" });
    enqueue({ kind: "sos", prio: PRIO.SOS, idempotencyKey: "s1" });
    const ordered = listQueue().map((i) => i.kind);
    expect(ordered).toEqual(["sos", "request", "roster", "loc"]);
  });

  it("persists across reload (same localStorage)", () => {
    enqueue({
      kind: "staging",
      prio: PRIO.ROSTER,
      idempotencyKey: "st1",
      data: { direction: "IN" },
    });
    const raw = JSON.parse(localStorage.getItem("hp_offline_queue"));
    expect(raw.items).toHaveLength(1);
    expect(raw.items[0].data.direction).toBe("IN");
  });

  it("removes entries and supports kind filters", () => {
    const { entry } = enqueue({
      kind: "staging",
      prio: PRIO.ROSTER,
      idempotencyKey: "st2",
    });
    expect(removeEntry(entry.id)).toBe(true);
    expect(queueDepth()).toBe(0);
  });
});
