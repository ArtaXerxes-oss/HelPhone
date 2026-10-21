import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { PowerManager, PresenceState, ThermalState, LocationSamplingTier } from "../src/lib/powerManager.js";

describe("ISP-096: 12-Hour Shift Battery & Thermal Management Engine", () => {
  let powerManager;

  beforeEach(() => {
    powerManager = new PowerManager({
      presenceGracePeriodMs: 15 * 60 * 1000,
      offlineTimeoutMs: 30 * 60 * 1000,
    });
  });

  afterEach(() => {
    powerManager.releaseWakelock();
  });

  describe("Geofence & Velocity Adaptive GPS Scheduling", () => {
    it("should select ON_SCENE tier with 1Hz high accuracy within 100m of incident", () => {
      const tierAt50m = powerManager.resolveSamplingTier(50, 0);
      expect(tierAt50m).toEqual(LocationSamplingTier.ON_SCENE);
      expect(tierAt50m.intervalMs).toBe(1000);
      expect(tierAt50m.accuracy).toBe("high");

      const tierAt100m = powerManager.resolveSamplingTier(100, 15);
      expect(tierAt100m).toEqual(LocationSamplingTier.ON_SCENE);
    });

    it("should select EN_ROUTE tier with 0.05Hz balanced accuracy when traveling beyond 100m", () => {
      const tier = powerManager.resolveSamplingTier(500, 8.5); // traveling at 8.5 m/s (~30 km/h)
      expect(tier).toEqual(LocationSamplingTier.EN_ROUTE);
      expect(tier.intervalMs).toBe(20000);
      expect(tier.accuracy).toBe("balanced");
    });

    it("should select STATIONARY tier with 0.016Hz low_power accuracy when resting beyond 100m", () => {
      const tier = powerManager.resolveSamplingTier(800, 0.2); // stationary or creeping
      expect(tier).toEqual(LocationSamplingTier.STATIONARY);
      expect(tier.intervalMs).toBe(60000);
      expect(tier.accuracy).toBe("low_power");
    });
  });

  describe("Doze-Aware Presence State Machine", () => {
    const now = 1700000000000;

    it("should classify responder as ACTIVE if heartbeat received within 60s", () => {
      const state = powerManager.evaluatePresenceState(now - 30000, now);
      expect(state).toBe(PresenceState.ACTIVE);
    });

    it("should classify responder as DOZE_SUSPECTED between 1m and 30m grace period", () => {
      const state5m = powerManager.evaluatePresenceState(now - 5 * 60 * 1000, now);
      expect(state5m).toBe(PresenceState.DOZE_SUSPECTED);

      const state25m = powerManager.evaluatePresenceState(now - 25 * 60 * 1000, now);
      expect(state25m).toBe(PresenceState.DOZE_SUSPECTED);
    });

    it("should classify responder as OFFLINE after exceeding 30m timeout", () => {
      const state = powerManager.evaluatePresenceState(now - 31 * 60 * 1000, now);
      expect(state).toBe(PresenceState.OFFLINE);
    });
  });

  describe("Thermal-Aware WASM Proving with Epoch-Cache Reuse", () => {
    it("should execute proof immediately under NOMINAL thermal conditions", () => {
      const result = powerManager.evaluateProofExecution("epoch_101", ThermalState.NOMINAL);
      expect(result.action).toBe("EXECUTE_IMMEDIATELY");
      expect(result.deferred).toBe(false);
    });

    it("should serve proof from cache without recomputing WASM proof", () => {
      powerManager.recordCachedProof("epoch_102", { zkProof: "0xdeadbeef", verified: true });

      const result = powerManager.evaluateProofExecution("epoch_102", ThermalState.CRITICAL);
      expect(result.action).toBe("SERVE_FROM_CACHE");
      expect(result.proof.zkProof).toBe("0xdeadbeef");
      expect(result.deferred).toBe(false);
    });

    it("should defer WASM proving when thermal state is SERIOUS or CRITICAL", () => {
      const seriousResult = powerManager.evaluateProofExecution("epoch_103", ThermalState.SERIOUS);
      expect(seriousResult.action).toBe("DEFERRED_THERMAL_PROTECTION");
      expect(seriousResult.deferred).toBe(true);
      expect(seriousResult.deferralId).toBeDefined();

      const criticalResult = powerManager.evaluateProofExecution("epoch_104", ThermalState.CRITICAL);
      expect(criticalResult.action).toBe("DEFERRED_THERMAL_PROTECTION");
      expect(criticalResult.deferred).toBe(true);

      expect(powerManager.deferredProofQueue.length).toBe(2);
      expect(powerManager.deferredProofQueue[0].epoch).toBe("epoch_103");
      expect(powerManager.deferredProofQueue[1].epoch).toBe("epoch_104");
    });
  });

  describe("Transient Audio Wakelock Budgeting", () => {
    it("should acquire transient wakelock with explicit max duration and auto-release", () => {
      const lock = powerManager.acquireTransientWakelock(3000);
      expect(lock.acquired).toBe(true);
      expect(lock.maxHoldMs).toBe(3000);
      expect(powerManager.hasActiveWakelock()).toBe(true);

      powerManager.releaseWakelock();
      expect(powerManager.hasActiveWakelock()).toBe(false);
    });

    it("should clear previous wakelock timeout when acquiring a new one", () => {
      powerManager.acquireTransientWakelock(5000);
      expect(powerManager.hasActiveWakelock()).toBe(true);

      powerManager.acquireTransientWakelock(2000);
      expect(powerManager.hasActiveWakelock()).toBe(true);
      expect(powerManager.activeWakelock.maxDuration).toBe(2000);
    });
  });

  describe("Mass-Wake Reconnection Coalescing with Jitter", () => {
    it("should generate bounded jitter to flatten connection storm", () => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        const delay = powerManager.calculateMassWakeJitter(attempt, 500, 4500);
        expect(delay).toBeGreaterThanOrEqual(500);
        expect(delay).toBeLessThanOrEqual(15000);
      }
    });

    it("should vary jitter across iterations preventing lockstep reconnection", () => {
      const delays = new Set();
      for (let i = 0; i < 20; i++) {
        delays.add(powerManager.calculateMassWakeJitter(1, 500, 4500));
      }
      // With random jitter up to 4500ms, distinct values should be high
      expect(delays.size).toBeGreaterThan(10);
    });
  });
});
