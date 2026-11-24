// @vitest-environment node
/**
 * #895 — offline storage quota, eviction and persistence policy (ADR-007).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend, WriteAheadBuffer, createStorageEngine } from "../src/services/storageEngine.js";
import {
  PERSIST_STATE_KEY,
  _resetPersistenceForTests,
  appendWithQuotaRecovery,
  createRetentionManager,
  getPersistenceState,
  onPersistenceChange,
  requestPersistentStorage,
} from "../src/services/storagePolicy.js";
import { hydratePaged } from "../src/services/crdtSync.js";

function memoryKv() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

describe("one-shot persistence request", () => {
  beforeEach(() => _resetPersistenceForTests());

  it("calls persist() once, records the outcome, and reuses it on later joins", async () => {
    const storage = { persisted: vi.fn(async () => false), persist: vi.fn(async () => true) };
    const kv = memoryKv();
    const seen = [];
    onPersistenceChange((s) => seen.push(s.status));

    const first = await requestPersistentStorage({ storage, kv, now: () => new Date("2026-11-23T10:00:00Z") });
    expect(first).toEqual({ status: "granted", requestedAt: "2026-11-23T10:00:00.000Z", trigger: "incident-join" });
    const second = await requestPersistentStorage({ storage, kv });
    expect(second).toBe(first);
    expect(storage.persist).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["granted"]);
    expect(JSON.parse(kv.map.get(PERSIST_STATE_KEY)).status).toBe("granted");
  });

  it("stays one-shot across reloads through the recorded state", async () => {
    const kv = memoryKv();
    await requestPersistentStorage({ storage: { persist: async () => false }, kv });
    _resetPersistenceForTests(); // a new page load
    const storage = { persist: vi.fn(async () => true) };
    expect((await requestPersistentStorage({ storage, kv })).status).toBe("denied");
    expect(storage.persist).not.toHaveBeenCalled();
    expect(getPersistenceState({ kv }).status).toBe("denied");
  });

  it("shares one request between concurrent joins", async () => {
    let resolve;
    const storage = { persist: vi.fn(() => new Promise((r) => (resolve = r))) };
    const kv = memoryKv();
    const a = requestPersistentStorage({ storage, kv });
    const b = requestPersistentStorage({ storage, kv });
    await new Promise((r) => setTimeout(r, 0));
    resolve(true);
    expect((await a).status).toBe("granted");
    expect((await b).status).toBe("granted");
    expect(storage.persist).toHaveBeenCalledTimes(1);
  });

  it("does not prompt when storage is already persistent, and reports unsupported browsers", async () => {
    const storage = { persisted: async () => true, persist: vi.fn() };
    expect((await requestPersistentStorage({ storage, kv: memoryKv() })).status).toBe("already-persisted");
    expect(storage.persist).not.toHaveBeenCalled();
    _resetPersistenceForTests();
    expect((await requestPersistentStorage({ storage: {}, kv: memoryKv() })).status).toBe("unsupported");
  });

  it("is requested when an incident join starts, without blocking it", async () => {
    const requestPersistence = vi.fn(async () => ({ status: "granted" }));
    const onPersistence = vi.fn();
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    });
    await hydratePaged({ doc: null, fetcher, requestPersistence, onPersistence, verifyReceipt: false }).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(requestPersistence).toHaveBeenCalledWith({ trigger: "incident-join" });
    expect(onPersistence).toHaveBeenCalledWith({ status: "granted" });
  });
});

describe("lossless lane for messages (zero-delay flush, never shed)", () => {
  it("never drops a message under telemetry backpressure", async () => {
    const backend = new MemoryBackend({ commitDelayMs: 20 });
    const engine = await createStorageEngine({ backend, buffer: { flushMs: 50, maxBuffered: 10 } });
    const telemetry = [];
    for (let i = 0; i < 40; i++) telemetry.push(engine.append("telemetry", { i, ts: i }).catch(() => "dropped"));
    const message = engine.append("messages", { text: "evacuate north", ts: 1 });
    for (let i = 40; i < 80; i++) telemetry.push(engine.append("telemetry", { i, ts: i }).catch(() => "dropped"));
    await expect(message).resolves.toBeTypeOf("number");
    const results = await Promise.all(telemetry);
    expect(results.filter((r) => r === "dropped").length).toBeGreaterThan(0); // telemetry was shed
    await engine.flush();
    expect(await engine.count("messages")).toBe(1);
    const s = engine.stats();
    expect(s.losslessBuffer.dropped).toBe(0);
    expect(s.buffer.dropped).toBeGreaterThan(0);
    await engine.close();
  });

  it("flushes messages without the telemetry batching delay", async () => {
    const engine = await createStorageEngine({ backend: new MemoryBackend(), buffer: { flushMs: 500 } });
    const t0 = performance.now();
    await engine.append("messages", { text: "hi", ts: 1 });
    expect(performance.now() - t0).toBeLessThan(250);
    await engine.close();
  });

  it("rejects instead of shedding when the message lane itself overflows", async () => {
    const wab = new WriteAheadBuffer(() => new Promise(() => {}), { flushMs: 0, maxBuffered: 2, overflow: "reject" });
    wab.enqueue("messages", { a: 1 });
    wab.enqueue("messages", { a: 2 });
    await expect(wab.enqueue("messages", { a: 3 })).rejects.toThrow("WriteAheadBuffer full");
    expect(wab.stats().dropped).toBe(1);
  });
});

describe("oldest-telemetry retention", () => {
  async function seeded(n) {
    const engine = await createStorageEngine({ backend: new MemoryBackend(), buffer: false });
    for (let i = 0; i < n; i++) await engine.append("telemetry", { seq: i, ts: i });
    for (let i = 0; i < 5; i++) await engine.append("messages", { seq: i, ts: i });
    return engine;
  }

  it("deletes the oldest telemetry above the record cap and keeps the newest", async () => {
    const engine = await seeded(120);
    const r = createRetentionManager({ engine, estimate: null, maxRecords: { telemetry: 100 } });
    expect((await r.enforce()).deleted).toEqual({ telemetry: 20 });
    const newest = await engine.readLatest("telemetry", 100);
    expect(newest.map((x) => x.seq).sort((a, b) => a - b)[0]).toBe(20);
    expect(Math.max(...newest.map((x) => x.seq))).toBe(119);
    expect(await engine.count("messages")).toBe(5);
  });

  it("evicts telemetry until usage falls below the low-water mark, never messages", async () => {
    const engine = await seeded(10_000);
    const estimate = async () => ({ quota: 1_000_000, usage: (await engine.count("telemetry")) * 100 + 5_000 });
    const r = createRetentionManager({ engine, estimate, highWater: 0.8, lowWater: 0.6, chunk: 500, maxRecords: {} });
    const { deleted, usage } = await r.enforce();
    expect(usage.usage / usage.quota).toBeLessThanOrEqual(0.6);
    expect(deleted.telemetry).toBe(4_500);
    expect(await engine.count("messages")).toBe(5);
    const oldestLeft = Math.min(...(await engine.readLatest("telemetry", 10_000)).map((x) => x.seq));
    expect(oldestLeft).toBe(4_500);
  });

  it("refuses to treat a protected store as evictable", () => {
    expect(() => createRetentionManager({ engine: {}, stores: ["telemetry", "messages"] })).toThrow(/protected store/);
  });
});

describe("quota-safe append", () => {
  function quotaEngine(fail) {
    const calls = [];
    return {
      calls,
      async append(store, record) {
        calls.push(["append", store]);
        if (fail.shift()) {
          const e = new Error("The quota has been exceeded.");
          e.name = "QuotaExceededError";
          throw e;
        }
        return 1;
      },
      async deleteOldest(store, n) {
        calls.push(["deleteOldest", store, n]);
        return store === "telemetry" ? n : 0;
      },
    };
  }

  it("frees space from telemetry and retries a message once", async () => {
    const engine = quotaEngine([true, false]);
    await expect(appendWithQuotaRecovery(engine, "messages", { t: "x" }, { evictCount: 50 })).resolves.toBe(1);
    expect(engine.calls).toEqual([
      ["append", "messages"],
      ["deleteOldest", "frames", 50],
      ["deleteOldest", "telemetry", 50],
      ["append", "messages"],
    ]);
  });

  it("surfaces the error for a message that still does not fit, and never deletes messages", async () => {
    const engine = quotaEngine([true, true]);
    await expect(appendWithQuotaRecovery(engine, "messages", { t: "x" })).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(engine.calls.some(([op, store]) => op === "deleteOldest" && store === "messages")).toBe(false);
  });
});

afterEach(() => _resetPersistenceForTests());
