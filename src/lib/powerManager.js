/**
 * 12-Hour Shift Battery & Thermal Management Engine (ISP-096 / Issue #768).
 *
 * Implements hardware-aware power budgeting for field responder devices:
 * 1. Geofence & Velocity Adaptive GPS Scheduling (1Hz active down to 0.016Hz stationary)
 * 2. Doze-Aware Presence State Machine (DozeSuspected vs Offline with grace periods)
 * 3. Thermal-Aware WASM Proving with Epoch-Cache Reuse
 * 4. Transient Audio Wakelock Budgeting (zero permanent wakelocks)
 * 5. Mass-Wake Reconnection Coalescing with Exponential Jitter
 */

export const PresenceState = {
  ACTIVE: "ACTIVE",
  DOZE_SUSPECTED: "DOZE_SUSPECTED",
  OFFLINE: "OFFLINE",
};

export const ThermalState = {
  NOMINAL: "NOMINAL",
  FAIR: "FAIR",
  SERIOUS: "SERIOUS",
  CRITICAL: "CRITICAL",
};

export const LocationSamplingTier = {
  ON_SCENE: { intervalMs: 1000, accuracy: "high" }, // 1Hz within 100m of incident
  EN_ROUTE: { intervalMs: 20000, accuracy: "balanced" }, // 0.05Hz when traveling
  STATIONARY: { intervalMs: 60000, accuracy: "low_power" }, // 0.016Hz when resting
};

export class PowerManager {
  constructor(options = {}) {
    this.presenceGracePeriodMs = options.presenceGracePeriodMs || 15 * 60 * 1000; // 15 mins Doze grace
    this.offlineTimeoutMs = options.offlineTimeoutMs || 30 * 60 * 1000; // 30 mins before marking Offline
    this.cachedProofs = new Map(); // epoch -> proof
    this.deferredProofQueue = [];
    this.activeWakelock = null;
    this.wakelockTimeout = null;
  }

  /**
   * Determine optimal GPS sampling cadence based on distance to incident and velocity.
   */
  resolveSamplingTier(distanceToIncidentMeters, velocityMetersPerSec = 0) {
    if (distanceToIncidentMeters <= 100) {
      return LocationSamplingTier.ON_SCENE;
    }

    if (velocityMetersPerSec < 0.5) {
      return LocationSamplingTier.STATIONARY;
    }

    return LocationSamplingTier.EN_ROUTE;
  }

  /**
   * Server-side presence state machine evaluation.
   * Prevents premature incident reassignment when responder enters Android Doze.
   */
  evaluatePresenceState(lastHeartbeatTimeMs, currentTimeMs = Date.now()) {
    const elapsedMs = currentTimeMs - lastHeartbeatTimeMs;

    if (elapsedMs < 60 * 1000) {
      return PresenceState.ACTIVE;
    }

    if (elapsedMs < this.offlineTimeoutMs) {
      return PresenceState.DOZE_SUSPECTED;
    }

    return PresenceState.OFFLINE;
  }

  /**
   * Evaluates if a WASM location proof should run immediately or be deferred due to thermal throttling.
   */
  evaluateProofExecution(epoch, currentThermalState = ThermalState.NOMINAL) {
    // 1. Check epoch cache first
    if (this.cachedProofs.has(epoch)) {
      return {
        action: "SERVE_FROM_CACHE",
        proof: this.cachedProofs.get(epoch),
        deferred: false,
      };
    }

    // 2. Thermal safety gate
    if (currentThermalState === ThermalState.SERIOUS || currentThermalState === ThermalState.CRITICAL) {
      const deferralId = `defer_${epoch}_${Date.now()}`;
      this.deferredProofQueue.push({ epoch, deferralId, queuedAt: Date.now() });

      return {
        action: "DEFERRED_THERMAL_PROTECTION",
        deferralId,
        deferred: true,
        reason: `Device thermal state is ${currentThermalState}. Deferring heavy WASM execution.`,
      };
    }

    return {
      action: "EXECUTE_IMMEDIATELY",
      deferred: false,
    };
  }

  /**
   * Store proof in epoch cache.
   */
  recordCachedProof(epoch, proof) {
    this.cachedProofs.set(epoch, proof);
  }

  /**
   * Transient wakelock manager for audible dispatch alerts.
   * Strictly caps wakelock duration to maxHoldMs (default 5 seconds), preventing battery drain.
   */
  acquireTransientWakelock(maxHoldMs = 5000) {
    this.releaseWakelock(); // Clear any existing

    this.activeWakelock = {
      acquiredAt: Date.now(),
      maxDuration: maxHoldMs,
    };

    this.wakelockTimeout = setTimeout(() => {
      this.releaseWakelock();
    }, maxHoldMs);

    return {
      acquired: true,
      maxHoldMs,
    };
  }

  releaseWakelock() {
    if (this.wakelockTimeout) {
      clearTimeout(this.wakelockTimeout);
      this.wakelockTimeout = null;
    }
    this.activeWakelock = null;
  }

  hasActiveWakelock() {
    return this.activeWakelock !== null;
  }

  /**
   * Calculates backoff delay with jitter for mass-wake reconnects.
   * Flattens the reconnect spike from 10,000 simultaneous wakeups.
   */
  calculateMassWakeJitter(attempt = 1, baseDelayMs = 500, maxJitterMs = 4500) {
    const jitter = Math.floor(Math.random() * maxJitterMs);
    const exponential = Math.min(baseDelayMs * Math.pow(1.5, attempt - 1), 10000);
    return Math.min(exponential + jitter, 15000);
  }
}
