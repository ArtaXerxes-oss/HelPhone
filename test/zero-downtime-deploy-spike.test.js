import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  ZeroDowntimeDeployManager,
  DeployState,
} from "../server/lib/zeroDowntimeDeploy.js";

describe("ISP-088: Zero-Downtime Deploy & Stateful Choreography Engine", () => {
  let deployManager;

  beforeEach(() => {
    deployManager = new ZeroDowntimeDeployManager({
      maxIndexerLag: 50,
      drainTimeoutMs: 15000,
    });
  });

  describe("Migration Advisory Fencing", () => {
    it("should acquire migration advisory lock and serialize DDL execution", async () => {
      const mockPg = {
        query: async (sql) => {
          if (sql.includes("pg_try_advisory_lock")) {
            return { rows: [{ acquired: true }] };
          }
          return { rows: [] };
        },
      };

      const acquired = await deployManager.acquireMigrationLock(mockPg);
      expect(acquired).toBe(true);
      expect(deployManager.state).toBe(DeployState.MIGRATING);

      await deployManager.releaseMigrationLock(mockPg);
      expect(deployManager.migrationsApplied).toBe(true);
      expect(deployManager.state).toBe(DeployState.INDEXER_CATCHUP);
    });

    it("should prevent duplicate migrations if another replica holds advisory lock", async () => {
      const mockPgCompetitor = {
        query: async (sql) => {
          if (sql.includes("pg_try_advisory_lock")) {
            return { rows: [{ acquired: false }] };
          }
          return { rows: [] };
        },
      };

      const acquired = await deployManager.acquireMigrationLock(mockPgCompetitor);
      expect(acquired).toBe(false);
      expect(deployManager.migrationsApplied).toBe(false);
    });
  });

  describe("Gated /readyz vs /healthz", () => {
    it("should return UP on /healthz regardless of migration or indexer state", () => {
      const health = deployManager.checkHealthz();
      expect(health.status).toBe("UP");
      expect(health.alive).toBe(true);
    });

    it("should return 503 on /readyz if migrations have not been applied", () => {
      deployManager.updateIndexerProgress(1000, 1010); // lag = 10, but no migrations
      const ready = deployManager.checkReadyz();
      expect(ready.httpCode).toBe(503);
      expect(ready.status).toBe("NOT_READY");
    });

    it("should return 503 on /readyz if indexer lag exceeds maxIndexerLag (50 ledgers)", () => {
      deployManager.migrationsApplied = true;
      deployManager.updateIndexerProgress(1000, 1080); // lag = 80 > 50

      const ready = deployManager.checkReadyz();
      expect(ready.httpCode).toBe(503);
      expect(ready.status).toBe("NOT_READY");
      expect(ready.indexerLag).toBe(80);
    });

    it("should return 200 on /readyz when migrations applied and indexer lag <= 50", () => {
      deployManager.migrationsApplied = true;
      deployManager.updateIndexerProgress(1000, 1025); // lag = 25 <= 50

      const ready = deployManager.checkReadyz();
      expect(ready.httpCode).toBe(200);
      expect(ready.status).toBe("READY");
      expect(ready.state).toBe(DeployState.READY);
    });
  });

  describe("Indexer Leader Election & Atomic Checkpointing", () => {
    it("should elect single indexer leader via PostgreSQL advisory lock", async () => {
      const mockPg = {
        query: async (sql) => {
          if (sql.includes("pg_try_advisory_lock")) {
            return { rows: [{ leader: true }] };
          }
          return { rows: [] };
        },
      };

      const isLeader = await deployManager.tryAcquireIndexerLeadership(mockPg);
      expect(isLeader).toBe(true);
      expect(deployManager.isIndexerLeader).toBe(true);
    });

    it("should commit batch events and checkpoint atomically in single transaction", async () => {
      const executed = [];
      const mockPg = {
        query: async (sql, params) => {
          executed.push({ sql, params });
          return { rows: [] };
        },
      };

      const events = [
        { id: "evt_1", seq: 501, payload: { type: "DISPATCH" } },
        { id: "evt_2", seq: 502, payload: { type: "CLAIM" } },
      ];

      const res = await deployManager.commitBatchWithCheckpoint(mockPg, events, 502);
      expect(res.success).toBe(true);
      expect(res.ledgerSeq).toBe(502);
      expect(deployManager.currentLedgerSeq).toBe(502);

      const sqls = executed.map((e) => e.sql);
      expect(sqls[0]).toBe("BEGIN");
      expect(sqls[sqls.length - 1]).toBe("COMMIT");
      expect(sqls.some((s) => s.includes("indexer_checkpoints"))).toBe(true);
    });

    it("should rollback transaction on error and prevent sequence update", async () => {
      const executed = [];
      const mockPgFail = {
        query: async (sql) => {
          executed.push(sql);
          if (sql.includes("INSERT INTO ledger_events")) {
            throw new Error("Disk full or constraint violation");
          }
          return { rows: [] };
        },
      };

      const events = [{ id: "evt_3", seq: 503, payload: {} }];
      await expect(deployManager.commitBatchWithCheckpoint(mockPgFail, events, 503)).rejects.toThrow();

      expect(executed).toContain("BEGIN");
      expect(executed).toContain("ROLLBACK");
      expect(deployManager.currentLedgerSeq).toBe(0); // Sequence not updated
    });
  });

  describe("Graceful WS Connection Draining", () => {
    it("should broadcast DEPLOY_DRAIN token with resumeSeq and clean up sockets", async () => {
      const sentMessages1 = [];
      const sentMessages2 = [];
      let closed1 = false;
      let closed2 = false;

      const ws1 = {
        lastSeenSeq: 420,
        send: (msg) => sentMessages1.push(JSON.parse(msg)),
        close: (code) => {
          closed1 = true;
        },
      };

      const ws2 = {
        lastSeenSeq: 425,
        send: (msg) => sentMessages2.push(JSON.parse(msg)),
        close: (code) => {
          closed2 = true;
        },
      };

      deployManager.registerWsConnection(ws1);
      deployManager.registerWsConnection(ws2);
      expect(deployManager.activeWsConnections.size).toBe(2);

      const drainResult = await deployManager.initiateGracefulDrain();
      expect(drainResult.drainedCount).toBe(2);
      expect(sentMessages1[0].type).toBe("DEPLOY_DRAIN");
      expect(sentMessages1[0].resumeSeq).toBe(420);
      expect(sentMessages2[0].resumeSeq).toBe(425);
      expect(closed1).toBe(true);
      expect(closed2).toBe(true);
      expect(deployManager.state).toBe(DeployState.TERMINATED);
    });
  });
});
