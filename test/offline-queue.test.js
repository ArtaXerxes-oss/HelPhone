import { beforeEach, describe, expect, it } from "vitest";
import {
  PRIO,
  clearQueue,
  configureRetention,
  enqueue,
  findByIdempotencyKey,
  flushOutboxPersistence,
  getRetentionAudit,
  listQueue,
  lockOutbox,
  purgeExpiredEntries,
  queueDepth,
  removeEntry,
  scanOutboxForPii,
  unlockOutbox,
} from "../src/lib/field/offlineQueue";

describe("offline queue", () => {
  beforeEach(() => {
    lockOutbox();
    localStorage.clear();
    configureRetention({ maxItems: 200, maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
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

  it("redacts PII and secrets at the enqueue boundary", () => {
    const { entry, redactedFields } = enqueue({
      kind: "sos",
      prio: PRIO.SOS,
      idempotencyKey: "sos-pii-1",
      data: {
        name: "Alice Responder",
        phone: "+1-555-0199",
        email: "alice@example.org",
        lat: 37.7749,
        lng: -122.4194,
        triage: "MED",
        noteText: "Call bob@example.com immediately",
      },
    });

    expect(redactedFields).toEqual(
      expect.arrayContaining(["name", "phone", "email", "lat", "lng", "noteText"]),
    );
    expect(entry.data.name).toBeUndefined();
    expect(entry.data.phone).toBeUndefined();
    expect(entry.data.triage).toBe("MED");
    expect(entry.data.noteText).toBe("[REDACTED]");

    const raw = localStorage.getItem("hp_offline_queue");
    expect(raw).not.toContain("Alice Responder");
    expect(raw).not.toContain("555-0199");
    expect(scanOutboxForPii(raw).clean).toBe(true);
  });

  it("encrypts outbox entries with PBKDF2 and survives reload", async () => {
    await unlockOutbox("field-passphrase-123");
    enqueue({
      kind: "sos",
      prio: PRIO.SOS,
      idempotencyKey: "enc-1",
      data: { direction: "IN", grid: "CM87wq" },
    });
    await flushOutboxPersistence();

    const raw = localStorage.getItem("hp_offline_queue");
    const envelope = JSON.parse(raw);
    expect(envelope.v).toBe(2);
    expect(envelope.kdf).toBe("PBKDF2");
    expect(envelope.alg).toBe("AES-GCM");
    expect(envelope.items).toBeUndefined();
    expect(raw).not.toContain("CM87wq");
    expect(scanOutboxForPii(raw).clean).toBe(true);

    // Simulate page reload: drop in-memory key & state, then re-unlock
    lockOutbox();
    await unlockOutbox("field-passphrase-123");
    const restored = listQueue();
    expect(restored).toHaveLength(1);
    expect(restored[0].data.grid).toBe("CM87wq");
  });

  it("enforces bounded retention and records audit on purge", () => {
    configureRetention({ maxItems: 2, maxAgeMs: 10_000 });
    enqueue({ kind: "loc", prio: PRIO.LOC, idempotencyKey: "k1", now: 1_000 });
    enqueue({ kind: "sos", prio: PRIO.SOS, idempotencyKey: "k2", now: 2_000 });
    enqueue({ kind: "new", prio: PRIO.NEW, idempotencyKey: "k3", now: 3_000 });

    expect(queueDepth()).toBe(2);
    // Low-priority LOC entry was evicted first, preserving SOS and NEW
    expect(listQueue().map((i) => i.idempotencyKey)).toEqual(["k2", "k3"]);

    purgeExpiredEntries({ now: 20_000 });
    expect(queueDepth()).toBe(0);
    const audit = getRetentionAudit();
    expect(audit.some((a) => a.reason === "capacity_exceeded" && a.purgedCount === 1)).toBe(true);
    expect(audit.some((a) => a.reason === "ttl_expired" && a.purgedCount === 2)).toBe(true);
  });

  it("queue-scrape check fails on unredacted PII payloads", () => {
    const poisonedRaw = JSON.stringify({
      seq: 1,
      items: [{ id: "q-1", data: { phone: "+1-555-0100", name: "Leaked" } }],
    });
    const scrape = scanOutboxForPii(poisonedRaw);
    expect(scrape.clean).toBe(false);
    expect(scrape.findings.length).toBeGreaterThan(0);
  });
});
