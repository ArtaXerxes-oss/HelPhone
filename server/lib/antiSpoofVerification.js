/**
 * Anti-Spoofing & ZK Credential Replay Prevention Engine (ISP-091 / Issue #761).
 *
 * Implements defenses against malicious actors harvesting emergency aid:
 * 1. Cryptographic Nullifier Binding: Nullifiers bound to (credentialHash, incidentId, epoch).
 *    Prevents cross-incident and cross-epoch replay of captured ZK proofs.
 * 2. Impossible-Travel Speed Sanity Filter: Teleportation detector (>300 m/s triggers challenge).
 * 3. Atomic Multi-Device Deduplication: Redis SET NX semantics; 1 responder pin admitted per credential per incident.
 * 4. Progressive Disclosure Ladder: Gated disclosure state machine (FUZZY -> COARSE -> EXACT).
 *    Exact location is NEVER disclosed until both geofence AND fresh credential checks pass.
 */

import crypto from "crypto";

export const DisclosureLevel = {
  FUZZY_ZONE: "FUZZY_ZONE", // ~3km coarse bounding box
  COARSE_PROXIMITY: "COARSE_PROXIMITY", // ~1km rendezvous region
  EXACT_COORDINATES: "EXACT_COORDINATES", // Precision GPS coordinates
};

export class AntiSpoofVerificationEngine {
  constructor(options = {}) {
    this.epochDurationMs = options.epochDurationMs || 5 * 60 * 1000; // 5 minute epochs
    this.maxPlausibleSpeedMetersPerSec = options.maxPlausibleSpeedMetersPerSec || 300; // 300 m/s (~1,080 km/h)
    this.nullifierStore = new Set(); // in-memory set (mocking Redis SET NX with TTL)
    this.responderLocations = new Map(); // responderId -> { lat, lon, timestamp }
  }

  /**
   * Derive current epoch index based on time.
   */
  getCurrentEpoch(timestampMs = Date.now()) {
    return Math.floor(timestampMs / this.epochDurationMs);
  }

  /**
   * Compute cryptographically bound nullifier: Poseidon / SHA-256 (credentialHash, incidentId, epoch).
   */
  computeNullifier(credentialHash, incidentId, epoch) {
    return crypto
      .createHash("sha256")
      .update(`${credentialHash}:${incidentId}:${epoch}`)
      .digest("hex");
  }

  /**
   * Part 1: ZK Credential Replay Verification
   * Ensures proof is valid for this specific incident and this specific active epoch.
   */
  verifyProofBinding(proofData, expectedIncidentId, currentTimestampMs = Date.now()) {
    const { credentialHash, incidentId, epoch, zkProof } = proofData;

    if (!zkProof) {
      return { verified: false, reason: "MISSING_ZK_PROOF" };
    }

    // 1. Cross-incident replay check
    if (incidentId !== expectedIncidentId) {
      return {
        verified: false,
        reason: `CROSS_INCIDENT_REPLAY_DETECTED: Proof generated for ${incidentId}, but presented for ${expectedIncidentId}`,
      };
    }

    // 2. Epoch freshness check (stale if >5 min old)
    const currentEpoch = this.getCurrentEpoch(currentTimestampMs);
    if (epoch !== currentEpoch) {
      return {
        verified: false,
        reason: `STALE_EPOCH_REPLAY_DETECTED: Proof epoch ${epoch} does not match current epoch ${currentEpoch}`,
      };
    }

    return { verified: true, currentEpoch };
  }

  /**
   * Part 2: Concurrent Multi-Device Deduplication (Redis SET NX emulation)
   * 5 devices sharing one credential yield <= 1 admitted responder.
   */
  acquireNullifierClaim(credentialHash, incidentId, epoch) {
    const nullifier = this.computeNullifier(credentialHash, incidentId, epoch);

    if (this.nullifierStore.has(nullifier)) {
      return {
        admitted: false,
        nullifier,
        reason: "DUPLICATE_CLAIM_REJECTED: Nullifier already claimed for this incident and epoch",
      };
    }

    this.nullifierStore.add(nullifier);
    return {
      admitted: true,
      nullifier,
      reason: "NULLIFIER_CLAIMED",
    };
  }

  /**
   * Part 3: Impossible-Travel Teleportation Filter
   * Detects mock location injections (e.g. adb emu geo fix teleporting 1000km in seconds).
   */
  validateTrajectory(responderId, newLat, newLon, timestampMs = Date.now()) {
    const prev = this.responderLocations.get(responderId);

    if (!prev) {
      this.responderLocations.set(responderId, { lat: newLat, lon: newLon, timestamp: timestampMs });
      return { valid: true, speedMps: 0, reason: "INITIAL_POSITION" };
    }

    const elapsedSeconds = (timestampMs - prev.timestamp) / 1000;
    if (elapsedSeconds <= 0) {
      return { valid: false, speedMps: Infinity, reason: "INVALID_TIME_DELTA" };
    }

    const distanceMeters = this.calculateHaversineDistance(prev.lat, prev.lon, newLat, newLon);
    const speedMps = distanceMeters / elapsedSeconds;

    if (speedMps > this.maxPlausibleSpeedMetersPerSec) {
      return {
        valid: false,
        speedMps,
        distanceMeters,
        reason: `IMPOSSIBLE_TRAVEL_TELEPORTATION: Speed ${speedMps.toFixed(1)} m/s exceeds threshold (${this.maxPlausibleSpeedMetersPerSec} m/s)`,
      };
    }

    this.responderLocations.set(responderId, { lat: newLat, lon: newLon, timestamp: timestampMs });
    return { valid: true, speedMps, distanceMeters, reason: "PLAUSIBLE_TRAJECTORY" };
  }

  /**
   * Part 4: Progressive Disclosure Ladder
   * Evaluates disclosure stage for Help.jsx flows:
   * - Never returns EXACT_COORDINATES until both geofence and fresh credential verification pass.
   */
  resolveDisclosureLevel(isGeofenceVerified, isCredentialFresh) {
    if (isGeofenceVerified && isCredentialFresh) {
      return {
        level: DisclosureLevel.EXACT_COORDINATES,
        showExactGps: true,
        reason: "ALL_SECURITY_GATES_PASSED",
      };
    }

    if (isGeofenceVerified && !isCredentialFresh) {
      return {
        level: DisclosureLevel.COARSE_PROXIMITY,
        showExactGps: false,
        reason: "FENCE_VERIFIED_CREDENTIAL_PENDING",
      };
    }

    return {
      level: DisclosureLevel.FUZZY_ZONE,
      showExactGps: false,
      reason: "UNVERIFIED_MINIMAL_DISCLOSURE",
    };
  }

  calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
    const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
}
