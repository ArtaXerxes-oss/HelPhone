import { describe, it, expect, beforeEach } from "vitest";
import {
  ChaosEngine,
  ScenarioType,
  PoolLane,
  AdmissionPriority,
  CHAOS_BREAK_GLASS_VALUE,
  armStartupChaos,
  assertChaosAllowed,
  chaosStartupConfig,
} from "../server/lib/chaosEngine.js";
import { createChaosAdmissionMiddleware, inferRequestType } from "../server/middleware/chaos.js";

describe("ISP-099: Correlated Multi-Fault Chaos Engineering Spike & Bulkhead Design", () => {
  let chaosEngine;

  beforeEach(() => {
    chaosEngine = new ChaosEngine({
      criticalCapacity: 5,
      backgroundCapacity: 10,
      txBatcherQueueLimit: 20,
    });
  });

  describe("Quad-Fault Injection Harness (Scenario: RED_WEDDING)", () => {
    it("should simultaneously inject all 4 faults and throttle CPU quota to 25%", () => {
      const run = chaosEngine.startScenario(ScenarioType.RED_WEDDING);

      expect(run.status).toBe("RUNNING");
      expect(run.scenario).toBe(ScenarioType.RED_WEDDING);
      expect(chaosEngine.isFaultActive("REDIS_OUTAGE")).toBe(true);
      expect(chaosEngine.isFaultActive("POSTGRES_PARTITION_DETACH")).toBe(true);
      expect(chaosEngine.isFaultActive("STELLAR_RPC_429_STORM")).toBe(true);
      expect(chaosEngine.isFaultActive("CPU_QUOTA_THROTTLE")).toBe(true);
      expect(run.cpuQuotaPercent).toBe(25);
    });

    it("should support targeted single-fault runs for baseline characterization", () => {
      chaosEngine.startScenario(ScenarioType.REDIS_ONLY);
      expect(chaosEngine.isFaultActive("REDIS_OUTAGE")).toBe(true);
      expect(chaosEngine.isFaultActive("POSTGRES_PARTITION_DETACH")).toBe(false);
      expect(chaosEngine.isFaultActive("STELLAR_RPC_429_STORM")).toBe(false);
    });
  });

  describe("Bulkhead 1: Connection Pool Lane Isolation", () => {
    it("should prevent background telemetry spikes from starving critical emergency lanes", () => {
      // Exhaust background lane (capacity = 10)
      for (let i = 0; i < 10; i++) {
        const res = chaosEngine.acquireConnection(PoolLane.BACKGROUND);
        expect(res.acquired).toBe(true);
      }

      // 11th background request should be rejected
      const overflowBg = chaosEngine.acquireConnection(PoolLane.BACKGROUND);
      expect(overflowBg.acquired).toBe(false);
      expect(overflowBg.reason).toContain("exhausted");

      // Critical emergency lane must still accept connections
      const criticalRes = chaosEngine.acquireConnection(PoolLane.CRITICAL);
      expect(criticalRes.acquired).toBe(true);
      expect(criticalRes.lane).toBe(PoolLane.CRITICAL);
      expect(criticalRes.activeInLane).toBe(1);

      // Releasing connection frees capacity
      chaosEngine.releaseConnection(PoolLane.BACKGROUND);
      const retryBg = chaosEngine.acquireConnection(PoolLane.BACKGROUND);
      expect(retryBg.acquired).toBe(true);
    });
  });

  describe("Bulkhead 2: Staged Admission Load-Shedding", () => {
    it("should admit all traffic under nominal operating conditions", () => {
      expect(chaosEngine.evaluateAdmission("MAP_TILES").admitted).toBe(true);
      expect(chaosEngine.evaluateAdmission("COARSE_TELEMETRY").admitted).toBe(true);
      expect(chaosEngine.evaluateAdmission("RESCUER_HEARTBEAT").admitted).toBe(true);
      expect(chaosEngine.evaluateAdmission("EMERGENCY_DISPATCH").admitted).toBe(true);
    });

    it("should shed map tiles and coarse telemetry while preserving emergency dispatch under chaos", () => {
      chaosEngine.startScenario(ScenarioType.RED_WEDDING);

      // Dropped non-critical telemetry
      const tilesResult = chaosEngine.evaluateAdmission("MAP_TILES");
      expect(tilesResult.admitted).toBe(false);
      expect(tilesResult.reason).toContain("SHED_UNDER_CHAOS");

      const coarseResult = chaosEngine.evaluateAdmission("COARSE_TELEMETRY");
      expect(coarseResult.admitted).toBe(false);

      // Preserved life-safety flows
      const heartbeatResult = chaosEngine.evaluateAdmission("RESCUER_HEARTBEAT");
      expect(heartbeatResult.admitted).toBe(true);

      const dispatchResult = chaosEngine.evaluateAdmission("EMERGENCY_DISPATCH");
      expect(dispatchResult.admitted).toBe(true);
    });
  });

  describe("Bulkhead 3: TxBatcher Bounded Queue & Overflow Spill", () => {
    it("should queue transactions up to limit during normal operation", () => {
      const res = chaosEngine.enqueueTx({ id: "tx_1", amount: 100 });
      expect(res.queued).toBe(true);
      expect(res.spilled).toBe(false);
      expect(chaosEngine.txBatcherQueue.length).toBe(1);
    });

    it("should spill transactions to overflow buffer when Stellar RPC 429 storm is active", () => {
      chaosEngine.startScenario(ScenarioType.RED_WEDDING);

      const res = chaosEngine.enqueueTx({ id: "tx_during_stall", amount: 50 });
      expect(res.queued).toBe(false);
      expect(res.spilled).toBe(true);
      expect(chaosEngine.txBatcherSpillBuffer.length).toBe(1);
      expect(chaosEngine.txBatcherSpillBuffer[0].reason).toBe("STELLAR_RPC_429_STORM");
    });
  });

  describe("Bulkhead 4: Verification Priority Queue under CPU Quota Throttling", () => {
    it("should prioritize active in-progress rescues over new joiners when CPU is throttled", () => {
      chaosEngine.startScenario(ScenarioType.RED_WEDDING); // drops CPU to 25%

      const joiner = { id: "res_new_joiner", isOnScene: false, activeRescue: false };
      const onScene = { id: "res_on_scene", isOnScene: true, activeRescue: false };
      const activeRescue = { id: "res_active_rescue", isOnScene: true, activeRescue: true };

      chaosEngine.scheduleProofVerification(joiner);
      chaosEngine.scheduleProofVerification(onScene);
      const rescueResult = chaosEngine.scheduleProofVerification(activeRescue);

      // Under 25% CPU throttle, only top 2 priority slots are runnable
      expect(rescueResult.availableSlots).toBe(2);
      expect(chaosEngine.verificationQueue[0].id).toBe("res_active_rescue");
      expect(chaosEngine.verificationQueue[1].id).toBe("res_on_scene");
      expect(chaosEngine.verificationQueue[2].id).toBe("res_new_joiner");
    });
  });

  describe("Safe Abort & Single-Command Rollback", () => {
    it("should clear all injected faults and restore CPU quota in a single command", () => {
      chaosEngine.startScenario(ScenarioType.RED_WEDDING);
      expect(chaosEngine.injectedFaults.size).toBe(4);

      const abortResult = chaosEngine.abort();
      expect(abortResult.status).toBe("ABORTED");
      expect(abortResult.faultsActive).toBe(0);
      expect(abortResult.cpuQuotaPercent).toBe(100);
      expect(chaosEngine.isFaultActive("REDIS_OUTAGE")).toBe(false);
    });

    it("should pass zero data loss and leak guard safety checks", () => {
      const integrity = chaosEngine.verifyIntegrity();
      expect(integrity.passed).toBe(true);
      expect(integrity.indexerGaps).toBe(0);
      expect(integrity.crdtResurrections).toBe(0);

      const leakGuard = chaosEngine.verifyLeakGuard({ liveSmsSent: 0, mainnetTxCount: 0 });
      expect(leakGuard.safe).toBe(true);
      expect(leakGuard.passed).toBe(true);
    });
  });

  describe("Opt-in startup gating and break glass (#769)", () => {
    it("is disabled by default and arms only when explicitly enabled", () => {
      const engine = new ChaosEngine();
      expect(armStartupChaos(engine, { CHAOS_ENABLED: undefined }).armed).toBe(false);
      const armed = armStartupChaos(engine, { CHAOS_ENABLED: "true", CHAOS_SCENARIO: ScenarioType.REDIS_ONLY });
      expect(armed.armed).toBe(true);
      expect(engine.activeScenario).toBe(ScenarioType.REDIS_ONLY);
    });

    it("refuses production without the explicit break-glass value", () => {
      const env = { NODE_ENV: "production", CHAOS_ENABLED: "true" };
      expect(chaosStartupConfig(env).reason).toBe("production_requires_break_glass");
      expect(() => assertChaosAllowed(chaosStartupConfig(env))).toThrow(/CHAOS_BREAK_GLASS/);
      expect(() => armStartupChaos(new ChaosEngine(), { ...env, CHAOS_BREAK_GLASS: "wrong" })).toThrow();

      const allowed = armStartupChaos(new ChaosEngine(), {
        ...env,
        CHAOS_BREAK_GLASS: CHAOS_BREAK_GLASS_VALUE,
      });
      expect(allowed.config.reason).toBe("break_glass");
      expect(allowed.armed).toBe(true);
    });

    it("keeps P0 paths alive through the admission middleware under three fault sets", () => {
      const middleware = createChaosAdmissionMiddleware(chaosEngine);
      for (const scenario of [ScenarioType.RED_WEDDING, ScenarioType.REDIS_ONLY, ScenarioType.POSTGRES_ONLY]) {
        chaosEngine.startScenario(scenario);
        let nextCalled = false;
        middleware({ url: "/api/dispatch/emergency", get: () => undefined }, {}, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);

        let status;
        let body;
        middleware(
          { url: "/api/tiles/1/2", get: () => undefined },
          { set: () => {}, status: (s) => { status = s; return { json: (b) => { body = b; } }; } },
          () => { throw new Error("map tiles should be shed"); },
        );
        expect(status).toBe(503);
        expect(body.error).toBe("shed_under_chaos");
        chaosEngine.abort();
      }
      expect(inferRequestType({ url: "/api/dispatch" })).toBe("EMERGENCY_DISPATCH");
    });

    it("stacks fault domains from a combined scenario while keeping P0 intact", () => {
      const engine = new ChaosEngine();
      const run = engine.startScenario([
        ScenarioType.REDIS_ONLY,
        ScenarioType.POSTGRES_ONLY,
        ScenarioType.CPU_ONLY,
      ]);
      expect(run.faults).toHaveLength(3);
      expect(engine.cpuQuotaPercent).toBe(25);
      expect(engine.evaluateAdmission("EMERGENCY_DISPATCH").admitted).toBe(true);
      expect(engine.evaluateAdmission("MAP_TILES").admitted).toBe(false);
      expect(engine.abort().rolledBack).toBe(true);
    });
  });
});
