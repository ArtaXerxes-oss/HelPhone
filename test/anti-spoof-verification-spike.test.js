import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  AntiSpoofVerificationEngine,
  DisclosureLevel,
} from "../server/lib/antiSpoofVerification.js";

describe("ISP-091: Anti-Spoofing & ZK Credential Replay Prevention Engine", () => {
  let engine;
  const now = 1700000000000;

  beforeEach(() => {
    engine = new AntiSpoofVerificationEngine({
      epochDurationMs: 5 * 60 * 1000, // 5 min
      maxPlausibleSpeedMetersPerSec: 300,
    });
  });

  describe("Cross-Incident & Stale-Epoch Replay Rejection", () => {
    it("should reject captured ZK proofs presented for a different incidentId (100% rejection)", () => {
      const currentEpoch = engine.getCurrentEpoch(now);

      const capturedProof = {
        credentialHash: "cred_hash_alpha_99",
        incidentId: "incident_alpha",
        epoch: currentEpoch,
        zkProof: "0xproof_valid_barretenberg_bytes",
      };

      // Attacker replays proof against incident_beta
      const result = engine.verifyProofBinding(capturedProof, "incident_beta", now);
      expect(result.verified).toBe(false);
      expect(result.reason).toContain("CROSS_INCIDENT_REPLAY_DETECTED");
    });

    it("should reject captured proofs from expired epochs (>5 min old)", () => {
      const staleEpoch = engine.getCurrentEpoch(now) - 2;

      const staleProof = {
        credentialHash: "cred_hash_alpha_99",
        incidentId: "incident_alpha",
        epoch: staleEpoch,
        zkProof: "0xproof_valid_barretenberg_bytes",
      };

      const result = engine.verifyProofBinding(staleProof, "incident_alpha", now);
      expect(result.verified).toBe(false);
      expect(result.reason).toContain("STALE_EPOCH_REPLAY_DETECTED");
    });

    it("should verify valid proof bound to correct incident and active epoch", () => {
      const currentEpoch = engine.getCurrentEpoch(now);

      const validProof = {
        credentialHash: "cred_hash_alpha_99",
        incidentId: "incident_alpha",
        epoch: currentEpoch,
        zkProof: "0xproof_valid_barretenberg_bytes",
      };

      const result = engine.verifyProofBinding(validProof, "incident_alpha", now);
      expect(result.verified).toBe(true);
      expect(result.currentEpoch).toBe(currentEpoch);
    });
  });

  describe("Concurrent Multi-Device Deduplication", () => {
    it("should admit only 1 device when 5 devices share one credential for the same incident", () => {
      const currentEpoch = engine.getCurrentEpoch(now);
      const sharedCred = "cred_sybil_swarm_001";
      const incidentId = "incident_central_hub";

      const attempts = [];
      for (let device = 1; device <= 5; device++) {
        attempts.push(engine.acquireNullifierClaim(sharedCred, incidentId, currentEpoch));
      }

      // First device admitted
      expect(attempts[0].admitted).toBe(true);
      expect(attempts[0].reason).toBe("NULLIFIER_CLAIMED");

      // Devices 2 through 5 rejected
      for (let i = 1; i < 5; i++) {
        expect(attempts[i].admitted).toBe(false);
        expect(attempts[i].reason).toContain("DUPLICATE_CLAIM_REJECTED");
      }
    });
  });

  describe("Impossible-Travel Teleportation Filter", () => {
    it("should allow plausible walking and driving trajectories", () => {
      const responderId = "resp_walker_01";
      let time = now;

      // Start in San Francisco
      const pos1 = engine.validateTrajectory(responderId, 37.7749, -122.4194, time);
      expect(pos1.valid).toBe(true);

      // Walk 100 meters over 60 seconds (~1.6 m/s)
      time += 60 * 1000;
      const pos2 = engine.validateTrajectory(responderId, 37.7758, -122.4194, time);
      expect(pos2.valid).toBe(true);
      expect(pos2.speedMps).toBeLessThan(5);
    });

    it("should reject mock GPS teleportation (> 300 m/s)", () => {
      const responderId = "resp_spoofer_02";
      let time = now;

      // Position in SF
      engine.validateTrajectory(responderId, 37.7749, -122.4194, time);

      // Teleport 500 km to Los Angeles in 10 seconds (~50,000 m/s)
      time += 10 * 1000;
      const teleport = engine.validateTrajectory(responderId, 34.0522, -118.2437, time);

      expect(teleport.valid).toBe(false);
      expect(teleport.reason).toContain("IMPOSSIBLE_TRAVEL_TELEPORTATION");
      expect(teleport.speedMps).toBeGreaterThan(300);
    });
  });

  describe("Progressive Disclosure Ladder (Help.jsx UX)", () => {
    it("should strictly gate exact coordinates until BOTH geofence and credential checks pass", () => {
      // 1. Both unverified -> FUZZY (~3km box)
      const stage1 = engine.resolveDisclosureLevel(false, false);
      expect(stage1.level).toBe(DisclosureLevel.FUZZY_ZONE);
      expect(stage1.showExactGps).toBe(false);

      // 2. Fence verified, but credential pending -> COARSE (~1km rendezvous)
      const stage2 = engine.resolveDisclosureLevel(true, false);
      expect(stage2.level).toBe(DisclosureLevel.COARSE_PROXIMITY);
      expect(stage2.showExactGps).toBe(false);

      // 3. Both verified -> EXACT GPS coordinates
      const stage3 = engine.resolveDisclosureLevel(true, true);
      expect(stage3.level).toBe(DisclosureLevel.EXACT_COORDINATES);
      expect(stage3.showExactGps).toBe(true);
    });
  });
});
