// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import {
  SqliteOpfsBackend,
  SqliteBusyError,
  getTelemetryPartitionName,
  createStorageEngine,
  assertWorkerContext,
  isWorkerContext,
} from "../src/services/storageEngine.js";

describe("Storage Maintenance & Contention (ISP-064)", () => {
  it("enforces worker isolation: assertWorkerContext throws when in browser main thread", () => {
    // In node/test, window is undefined, so assertWorkerContext passes
    expect(() => assertWorkerContext()).not.toThrow();

    // Emulate window & document present (browser main thread)
    globalThis.window = {};
    globalThis.document = {};
    try {
      expect(() => assertWorkerContext()).toThrow(/WorkerIsolationError/);
    } finally {
      delete globalThis.window;
      delete globalThis.document;
    }
  });

  it("partitions telemetry writes into monthly tables and maintains unified view", async () => {
    const backend = new SqliteOpfsBackend({
      vfs: "memory",
      journalMode: "wal",
      sqlite3InitModule,
      allowMainThread: true,
    });
    await backend.open();

    const marchTs = new Date("2026-03-15T12:00:00Z").getTime();
    const aprilTs = new Date("2026-04-15T12:00:00Z").getTime();

    expect(getTelemetryPartitionName(marchTs)).toBe("telemetry_202603");
    expect(getTelemetryPartitionName(aprilTs)).toBe("telemetry_202604");

    // Write batches with different timestamps
    await backend.writeBatch("telemetry", [
      { ts: marchTs, worker: 1, seq: 1, lat: 6.5, lng: 3.3, acc: 5, payload: { note: "march" } },
    ]);
    await backend.writeBatch("telemetry", [
      { ts: aprilTs, worker: 1, seq: 2, lat: 6.6, lng: 3.4, acc: 4, payload: { note: "april" } },
    ]);

    // Query through the view
    expect(await backend.count("telemetry")).toBe(2);
    const latest = await backend.readLatest("telemetry", 10);
    expect(latest).toHaveLength(2);

    // Verify individual partition tables exist
    const p1Count = Number(backend.db.selectValue("SELECT count(*) FROM telemetry_202603"));
    const p2Count = Number(backend.db.selectValue("SELECT count(*) FROM telemetry_202604"));
    expect(p1Count).toBe(1);
    expect(p2Count).toBe(1);

    backend.close();
  });

  it("retention reclaim: dropPartition / dropExpiredTelemetry instantly frees expired data without VACUUM", async () => {
    const backend = new SqliteOpfsBackend({
      vfs: "memory",
      journalMode: "wal",
      sqlite3InitModule,
      allowMainThread: true,
    });
    await backend.open();

    // Populate old partition and current partition
    const oldTs = Date.now() - 45 * 86400000; // 45 days ago
    const currentTs = Date.now();
    const oldPartition = getTelemetryPartitionName(oldTs);

    await backend.writeBatch("telemetry", [
      { ts: oldTs, worker: 1, seq: 1, lat: 6.5, lng: 3.3, acc: 5, payload: null },
    ]);
    await backend.writeBatch("telemetry", [
      { ts: currentTs, worker: 1, seq: 2, lat: 6.5, lng: 3.3, acc: 5, payload: null },
    ]);

    expect(await backend.count("telemetry")).toBe(2);

    // Drop the expired partition metadata-only
    const dropped = backend.dropPartition(oldPartition);
    expect(dropped).toBe(1);

    // View should immediately reflect only current partition
    expect(await backend.count("telemetry")).toBe(1);
    const remaining = await backend.readLatest("telemetry", 10);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].seq).toBe(2);

    backend.close();
  });

  it("incremental_vacuum pages through freelist with page budget and aborts on dispatch backlog", async () => {
    const backend = new SqliteOpfsBackend({
      vfs: "memory",
      journalMode: "wal",
      sqlite3InitModule,
      allowMainThread: true,
    });
    await backend.open();

    // Create records and delete to populate freelist
    const records = Array.from({ length: 200 }, (_, i) => ({
      ts: Date.now(),
      worker: 0,
      seq: i,
      lat: 6.5,
      lng: 3.3,
      acc: 5,
      payload: { data: "x".repeat(500) },
    }));
    await backend.writeBatch("telemetry", records);
    await backend.deleteOldest("telemetry", 150);

    const freelistBefore = Number(backend.db.selectValue("PRAGMA freelist_count") || 0);

    // Run incremental vacuum with budget
    const result = await backend.incrementalVacuum({ pages: 10, maxPages: 50 });
    expect(result.aborted).toBe(false);

    // Test abort when dispatch backlog > 0
    let backlog = 1;
    const abortResult = await backend.incrementalVacuum({
      pages: 5,
      abortOnBacklog: () => backlog > 0,
    });
    expect(abortResult.aborted).toBe(true);
    expect(abortResult.reason).toBe("dispatch_backlog");

    backend.close();
  });

  it("priority transactions: dispatch inserts use BEGIN IMMEDIATE and throw SqliteBusyError under contention", async () => {
    const backend = new SqliteOpfsBackend({
      vfs: "memory",
      journalMode: "wal",
      sqlite3InitModule,
      allowMainThread: true,
    });
    await backend.open();

    // Normal dispatch write
    await backend.writeBatch("dispatches", [{ ts: Date.now(), worker: 1, seq: 101, lat: 6.5, lng: 3.3, acc: 5, payload: { type: "dispatch" } }], {
      lane: "dispatch",
      priority: "immediate",
    });
    expect(await backend.count("dispatches")).toBe(1);

    // Simulate lock contention where another connection holds the lock
    const origExec = backend.db.exec.bind(backend.db);
    backend.db.exec = (sql) => {
      if (typeof sql === "string" && sql.includes("BEGIN IMMEDIATE")) {
        const err = new Error("SQLITE_BUSY: database is locked");
        err.resultCode = 5;
        throw err;
      }
      return origExec(sql);
    };

    // Dispatch write should throw SqliteBusyError to allow IDB outbox fallback
    await expect(
      backend.writeBatch("dispatches", [{ ts: Date.now(), worker: 1, seq: 102, lat: 6.5, lng: 3.3, acc: 5, payload: null }], {
        lane: "dispatch",
        priority: "immediate",
        busyTimeout: 20,
      })
    ).rejects.toThrow(SqliteBusyError);

    // Telemetry write under contention should coalesce / drop gracefully without throwing
    backend.db.exec = (sql) => {
      if (typeof sql === "string" && sql.includes("BEGIN DEFERRED")) {
        const err = new Error("SQLITE_BUSY: database is locked");
        err.resultCode = 5;
        throw err;
      }
      return origExec(sql);
    };

    let coalescedCalled = false;
    const telemRes = await backend.writeBatch(
      "telemetry",
      [{ ts: Date.now(), worker: 1, seq: 999, lat: 6.5, lng: 3.3, acc: 5, payload: null }],
      { lane: "telemetry", priority: "deferred", onCoalesce: () => (coalescedCalled = true) }
    );

    expect(telemRes.dropped).toBe(1);
    expect(telemRes.coalesced).toBe(true);
    expect(coalescedCalled).toBe(true);

    backend.db.exec = origExec;
    backend.close();
  });
});
