import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  SecretRotationManager,
  SecretType,
} from "../server/lib/secretRotationManager.js";

describe("ISP-090: Secrets Rotation Without Restart Manager", () => {
  let manager;

  beforeEach(() => {
    manager = new SecretRotationManager({
      [SecretType.STELLAR_KEY]: "SB222222222222222222222222222222222222222222222222222222",
      [SecretType.REDIS_URL]: "redis://default:old_pass@localhost:6379",
      [SecretType.DATABASE_URL]: "postgres://app:old_db_pass@localhost:5432/helphone",
    });
  });

  afterEach(() => {
    manager.cleanup();
  });

  describe("Atomic Environment Re-Validation", () => {
    it("should reject malformed Stellar secrets and retain last-known-good", async () => {
      const invalidKey = "NOT_A_STELLAR_KEY";

      await expect(
        manager.rotateSecret(SecretType.STELLAR_KEY, invalidKey)
      ).rejects.toThrow("Invalid Stellar secret key format");

      // Verify last-known-good retained
      const active = manager.secrets.get(SecretType.STELLAR_KEY);
      expect(active.value).toBe("SB222222222222222222222222222222222222222222222222222222");
      expect(active.generation).toBe(1);
    });

    it("should reject invalid URL schemes for database and redis", async () => {
      await expect(
        manager.rotateSecret(SecretType.REDIS_URL, "http://invalid-scheme")
      ).rejects.toThrow("Invalid URL scheme");
    });
  });

  describe("Dual-Trust Window for Cryptographic Keys", () => {
    it("should accept signatures from both Generation N and Generation N-1 during grace period", async () => {
      const oldSecret = "SB222222222222222222222222222222222222222222222222222222";
      const newSecret = "SC333333333333333333333333333333333333333333333333333333";

      // Rotate to new secret with 5000ms grace period
      await manager.rotateSecret(SecretType.STELLAR_KEY, newSecret, { gracePeriodMs: 5000 });

      // Verification function matching against secret
      const verifyWithOld = (sec) => sec === oldSecret;
      const verifyWithNew = (sec) => sec === newSecret;
      const verifyWithAttacker = (sec) => sec === "S_ATTACKER_KEY";

      // 1. New generation verifies directly
      const newResult = manager.verifyWithDualTrust(SecretType.STELLAR_KEY, verifyWithNew);
      expect(newResult.valid).toBe(true);
      expect(newResult.generation).toBe(2);
      expect(newResult.dualTrustFallback).toBe(false);

      // 2. Old generation verifies via dual-trust fallback
      const oldResult = manager.verifyWithDualTrust(SecretType.STELLAR_KEY, verifyWithOld);
      expect(oldResult.valid).toBe(true);
      expect(oldResult.generation).toBe(1);
      expect(oldResult.dualTrustFallback).toBe(true);

      // 3. Invalid key rejected
      const badResult = manager.verifyWithDualTrust(SecretType.STELLAR_KEY, verifyWithAttacker);
      expect(badResult.valid).toBe(false);
    });
  });

  describe("Blue-Green Connection Pool Rebirth", () => {
    it("should verify new pool, swap secret, and gracefully drain old pool", async () => {
      let oldPoolDrained = false;
      let newPoolPinged = false;

      const oldPoolMock = {
        drain: async () => {
          oldPoolDrained = true;
        },
      };

      const newPoolMock = {
        ping: async () => {
          newPoolPinged = true;
          return true;
        },
      };

      const newDbUrl = "postgres://app:new_secure_pass@localhost:5432/helphone";
      const swapResult = await manager.swapConnectionPool(
        SecretType.DATABASE_URL,
        newDbUrl,
        oldPoolMock,
        newPoolMock
      );

      expect(swapResult.status).toBe("POOL_SWAPPED");
      expect(swapResult.drainedOldPool).toBe(true);
      expect(newPoolPinged).toBe(true);
      expect(oldPoolDrained).toBe(true);
      expect(manager.secrets.get(SecretType.DATABASE_URL).value).toBe(newDbUrl);
    });
  });

  describe("Secret Generation & Skew Telemetry", () => {
    it("should track and expose current secret generation for fleet monitoring", async () => {
      const telemetry1 = manager.getSecretTelemetry();
      expect(telemetry1.currentGeneration).toBe(1);
      expect(telemetry1.activeSecretsCount).toBe(3);

      await manager.rotateSecret(
        SecretType.STELLAR_KEY,
        "SD444444444444444444444444444444444444444444444444444444"
      );

      const telemetry2 = manager.getSecretTelemetry();
      expect(telemetry2.currentGeneration).toBe(2);
    });
  });
});
