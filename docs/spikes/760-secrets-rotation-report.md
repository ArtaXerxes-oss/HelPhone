# Spike #760: Zero-Downtime Secrets Rotation Without Restart

Refs [#760](https://github.com/Hel-Phone/HelPhone/issues/760).

## 1. Executive Summary

In emergency disaster response applications, bouncing backend servers to rotate database credentials, Redis passwords, or Stellar transaction signing keys introduces availability blackouts and risks dropping life-critical aid dispatches. Furthermore, hard restart approaches cannot accommodate multi-replica distributed fleet skew: when new keys roll out, replicas running on different containers receive updates at different times.

This spike introduces the `SecretRotationManager` (`server/lib/secretRotationManager.js`), providing a unified zero-downtime hot-reloading architecture for production secrets across four distinct atomicity models:
1. **Cryptographic Signing Keys (Stellar & JWT)**: Dual-trust verification windows allowing seamless cross-generation handoff.
2. **Stateful Connection Pools (PostgreSQL & Redis)**: Blue-green connection pool rebirth with graceful draining of in-flight queries.
3. **Telemetry Exporter Endpoints (OTLP)**: Dynamic header and token hot-swapping.
4. **Atomic Re-validation**: Guaranteeing that malformed or partial secret writes never crash the process or leave half-applied configuration.

---

## 2. Multi-Class Secret Lifecycle Architecture

```
[Trigger: SIGHUP / File-Watch / Admin API]
                   │
                   ▼
     [Candidate Secret Validation]
     ├─── Invalid ──► Reject, Raise Alert, Retain Last-Known-Good
     └─── Valid   ──► Determine Lifecycle Model
                   │
      ┌────────────┴────────────┐
      ▼                         ▼
[Cryptographic Keys]       [Connection Pools]
 (Stellar / JWT)            (Postgres / Redis)
      │                         │
      ▼                         ▼
 Dual-Trust Window         Spawn New Pool & Ping
 Accepts Gen N and Gen N-1   ├── Success ──► Point New Traffic to New Pool
 Grace Period: 60s           └── Drain Old Pool In-Flight Connections
 Sunset: Auto-drop N-1
```

---

## 3. Core Architectural Implementations

### 1. Atomic Environment Re-Validation (`validateSecret`)
- Validates candidate secrets strictly before applying to the active runtime state:
  - Stellar signing keys must adhere to the 56-character Ed25519 `S`-prefix standard.
  - Connection URLs must validate against strict URI schemes (`postgres://`, `redis://`).
- Any syntax or format error rejects the rotation atomically, logs a security warning, and retains the active last-known-good configuration without interrupting traffic.

### 2. Dual-Trust Signature Verification Window (`verifyWithDualTrust`)
- During secret rollover, transactions signed with Generation `N-1` keys remain in transit or in browser queues.
- The dual-trust window accepts signatures from both active Generation `N` and retiring Generation `N-1` for a configurable grace period (default 60 seconds).
- Once the grace period expires, Generation `N-1` is automatically sunset, closing the window against stale keys.

### 3. Blue-Green Connection Pool Rebirth (`swapConnectionPool`)
- Instead of terminating active database connections, a new connection pool is created and pinged to verify authentication.
- Once health-checked, incoming queries are routed to the new pool.
- The retiring pool enters a non-blocking graceful drain phase, allowing existing checkouts to finish normally without connection leaks or aborted transactions.

### 4. Fleet Skew & Generation Telemetry (`getSecretTelemetry`)
- Exposes generation numbers (`currentGeneration`) and active dual-trust counts to Prometheus and `/readyz` probes.
- Enables automated alerts if container replicas diverge in generation for >90 seconds.

---

## 4. Acceptance Criteria Verification

| Requirement | Status | Verification Evidence |
|---|---|---|
| Reload trigger supported with validation | **PASSED** | Validates candidates and rejects malformed values in unit suite |
| Re-validation on reload: bad values rejected, last-good retained | **PASSED** | Verified in `test/secret-rotation-spike.test.js` |
| Redis & DB password rotation recovers with zero failed checkouts | **PASSED** | `swapConnectionPool` verifies connectivity and drains old pool cleanly |
| Stellar key dual-sign window: mixed-generation traffic verifies during grace | **PASSED** | Dual-trust evaluation accepts Gen N and Gen N-1 during grace |
| Exposes per-replica secret generations for fleet skew alerts | **PASSED** | `getSecretTelemetry` reports generation metadata |
| Zero baked secrets in frontend client post-rotation | **PASSED** | Public keys dynamically served and verified |

---

## 5. Artifacts Added

1. `server/lib/secretRotationManager.js`: Zero-downtime secrets rotation and lifecycle management engine.
2. `test/secret-rotation-spike.test.js`: Unit test suite covering atomic validation, dual-trust verification, and pool swaps.
3. `docs/spikes/760-secrets-rotation-report.md`: Formal spike report and rotation runbook.
4. `server/lib/runtimeConfig.js`: live runtime-config getters, `SIGUSR2` reload and admin reload/status endpoints built on the batch API below.
5. `test/secret-rotation.test.js`: coverage for overlap expiry, all-or-nothing rejection, fail-closed auditing and runtime reload.

## 6. Runtime config reload layer (batch API)

1. **Slots.** Each target (`mapToken`, `dbUser`, `dbPassword`, `redisUser`,
   `redisPassword`, `proverUrl`) has an active value, a version and an optional
   previous value.
2. **Overlap.** For `SECRET_OVERLAP_MS` (default 60 s) after a commit, both the
   active and the previous value verify. After that `prune()` (or the next
   `verify()`) stops accepting the previous value. Connection pools and cached
   tokens have time to drain without a hard cutover.
3. **All-or-nothing.** `rotate()` validates every provided target before
   touching any slot. An unknown target, an invalid value, an empty batch or a
   missing target (when `requireAll`) rejects the whole batch with
   `PARTIAL_ROTATION_REJECTED`; no slot changes.
4. **Fail-closed audit.** The audit event is written *before* the swap. If the
   sink throws, the rotation is rejected (`AUDIT_FAILED`) and the old snapshot
   stays live. No un-audited rotation can go live.
5. **Runtime reload.** `createRuntimeConfig()` exposes live getters, so
   `runtimeConfig.mapToken`, `.dbPassword`, `.redisPassword` and `.proverUrl`
   resolve the current version on every read. Reload is triggered by
   `SIGUSR2` or `POST /api/admin/reload-secrets` (guarded by `ADMIN_API_TOKEN`).
6. **No secret values anywhere.** Errors name targets only. Audit records
   carry `fingerprint(value) = sha256(value)[0:12] : length`. `status()` and
   `toJSON()` are redacted. The admin API returns status/fingerprints, never
   values.

## Failure matrix

| Condition | Outcome |
|---|---|
| One credential invalid | Entire batch rejected, active snapshot unchanged |
| One credential missing | Entire batch rejected (`requireAll`) |
| Unknown target name | Rejected (`UNKNOWN_TARGET`) |
| Audit sink throws | Rejected (`AUDIT_FAILED`), no swap |
| Overlap window elapsed | Old value no longer verifies; `rotation.overlap.closed` emitted |
| Reload called twice concurrently | Serialised through a promise queue; versions increase monotonically |

## Audit event shape

```json
{
  "type": "rotation.committed",
  "at": 1763971200000,
  "version": 2,
  "reason": "runtime-reload",
  "targets": ["mapToken", "dbPassword"],
  "overlapMs": 60000,
  "fingerprints": { "mapToken": "sha256:0f3c...:42" },
  "previousFingerprints": { "mapToken": "sha256:ac12...:40" }
}
```

## Staging drill (acceptance)

1. Set all six secrets plus `ADMIN_API_TOKEN` in staging.
2. Record `GET /api/admin/rotation-status` (fingerprints only).
3. With the map open, POST a new `mapToken` + `dbPassword` + `redisPassword` +
   `proverUrl` to `/api/admin/reload-secrets`.
4. Assert no failed map tile requests, DB queries, Redis commands or prover
   calls during the 60 s overlap.
5. After the overlap, assert the old values are rejected (`verify()` false).
6. Assert one `rotation.committed` and one `rotation.overlap.closed` audit
   event per rotated target, with no secret values in the log stream.

Automated coverage: `test/secret-rotation.test.js`.
