# Spike #760 — Secrets rotation without downtime

| | |
|---|---|
| Status | Implemented (staging drill pending) |
| Subsystem | security / platform |
| Priority | P1 |
| Grounding | `scripts/security/env_firewall.js`, `server/env.js` |
| Implementation | `server/lib/secretRotationManager.js`, `server/lib/runtimeConfig.js` |

## Problem

The server read `MAPBOX_TOKEN`, `DB_*`, `REDIS_*` and `PROVER_URL` once at
module load. Rotating any of them meant a redeploy, and rotating a group of
credentials one-by-one left a window where one client had the new value and
another still had the old one. The build-time firewall (`env_firewall.js`)
already prevents secrets leaking into static bundles; this spike covers the
runtime half of the lifecycle.

## Design

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
