# Disaster Recovery — Incident Bundle Runbook

## Single command

During an incident, collect logs + config + build provenance into one
manifest-led archive:

```bash
npm run bundle -- collect --since 2h --tier volunteer-safe --out incident-bundle.tgz
```

Options:

| Flag                                    | Meaning                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `--since 2h`                            | Collection window (`30m`, `2h`, `1d`, …). Only recent log lines are sliced.        |
| `--log-file <path>`                     | Morgan/structured log file to slice (`server-logs/slice.txt`).                     |
| `--dispatch`                            | Marks the bundle as produced during an active dispatch.                            |
| `--tier volunteer-safe`                 | Default. Secrets **and** PII scrubbed — safe to share with volunteers.             |
| `--tier command-internal --break-glass` | Full-fidelity PII (secrets still redacted). Writes `audit-log.json`, 7-day expiry. |
| `--out <file.tgz>`                      | Output path.                                                                       |

Verify a bundle's integrity (per-file SHA-256 vs `manifest.json`):

```bash
npm run bundle:verify -- incident-bundle.tgz
```

Scan any artifact for secrets/PII before sharing:

```bash
node scripts/security/env_firewall.js --scan some-log.txt
```

## What's inside

- `manifest.json` — collector identity, collection window, git commit/branch,
  feature-flag versions, per-file sha256 + redaction version + source,
  expiry date.
- `server-logs/` — time-sliced, scrubbed log output.
- `config/` — env allowlist (`VITE_*` only), feature-flag snapshot, build
  defines (COOP/COEP, PWA display/scope).
- `build/` — SBOM: `package-lock.json` / `package.json` hashes, `dist/assets`
  chunk hashes (when built), WASM hashes (when present), container digest
  from `CONTAINER_DIGEST`/`IMAGE_DIGEST`.
- `ledger/`, `metrics/`, `client/` — populated when the corresponding
  artifacts/scripts exist in the checkout.

## Retention

Every manifest carries `expiresAt` (volunteer-safe: 30 days,
command-internal: 7 days). Delete expired bundles per ISP-128 retention.
Break-glass access is recorded in `audit-log.json` inside the bundle and
must be reconciled against `docs/legal-compliance.md` audit requirements.

## Escalation order

1. `collect --tier volunteer-safe` — share with responders/volunteers.
2. If PII forensics are required: `collect --tier command-internal
--break-glass`, log the justification, share only through approved
   channels.
3. Always `verify` any bundle before trusting it in a postmortem.

---

*Appendix (from main): Disaster Recovery & Soroban State Backup Runbook*

## Overview

HelPhone utilizes an automated Soroban storage state backup system to safeguard contract state data. Contract storage entries (instance, persistent, and temporary) are inspected, parsed, and dumped into versioned JSON snapshot files indexed by Stellar ledger sequence numbers.

---

## Technical Architecture

```
+---------------------------+       +---------------------------+
|  Soroban RPC / Node       | ----> | export-contract-state.sh  |
|  (stellar contract inspect|       |   (CLI & RPC Exporter)    |
+---------------------------+       +---------------------------+
              |                                   |
              v                                   v
+---------------------------+       +---------------------------+
| server/indexer/exporter.ts | ----> |  JSON Snapshot Storage    |
|   (Daily Backup Cron)     |       | ./snapshots/snapshot-*.json|
+---------------------------+       +---------------------------+
```

---

## Storage Snapshot Format

Snapshots are exported in structured JSON format with complete ledger indexing:

```json
{
  "ledgerSequence": 123456,
  "contractId": "CC325F37QW7N2F5M3QGHL4A4O7J2K9L0M1N2O3P4Q5R6S7T8U9V0",
  "timestamp": "2026-09-24T16:00:00.000Z",
  "entries": [
    {
      "key": "CONTRACT_ADMIN",
      "val": { "address": "CC325F37QW7N2F5M3QGHL4A4O7J2K9L0M1N2O3P4Q5R6S7T8U9V0" },
      "durability": "persistent",
      "lastModifiedLedgerSeq": 123450
    }
  ],
  "metadata": {
    "exporterVersion": "1.0.0",
    "totalEntries": 1,
    "networkPassphrase": "Test SDF Network ; September 2015",
    "rpcUrl": "https://soroban-testnet.stellar.org"
  }
}
```

---

## Executing Manual Backups

Run the state exporter shell script:

```bash
# Export using default contract ID and testnet RPC
bash scripts/export-contract-state.sh

# Export with explicit environment variables
CONTRACT_ID="C..." SOROBAN_RPC_URL="https://soroban-testnet.stellar.org" bash scripts/export-contract-state.sh
```

---

## Server Automated Daily Backup Cron

The backend server (`server/index.ts`) initializes an automated daily cron task on startup.
- **Interval**: 24 hours (86,400,000 ms)
- **Output Directory**: `./snapshots/`
- **REST Endpoint**:
  - `POST /api/state/export` - Trigger state dump on demand
  - `GET /api/state/snapshots/latest` - Fetch the latest state snapshot

---

## Disaster Recovery & State Restoration

In case of network partition, state corruption, or redeployment:

1. **Locate Latest Snapshot**:
   ```bash
   ls -la snapshots/snapshot-*.json | sort | tail -n 1
   ```

2. **Verify Snapshot Integrity**:
   Run tests or use `verifySnapshotIntegrity()` helper:
   ```bash
   npm test test/state-export.test.js
   ```

3. **Restore Contract State**:
   Execute Stellar CLI contract restore/invoke commands using snapshot entry payloads:
   ```bash
   stellar contract invoke --id <CONTRACT_ID> --source <ADMIN_KEY> -- restore_state --snapshot-file snapshots/snapshot-123456.json
   ```

## Kill-switch runbook (#797)

Kill-switches are versioned. Every flip bumps the global flag version.

```bash
curl -X POST https://<host>/api/flags \
  -H "Authorization: Bearer $FLAGS_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"kills":{"soroban.submit":false}}'
```

How a kill propagates:

1. **Server enforcement (immediate, all cohorts):** routes guarded by
   `enforceKillSwitch(key)` return `503 kill_switch_active`. A request stamped
   with an older `x-helphone-flag-version` than the kill gets
   `409 quarantined`. It is held for review, not executed. Guarded today:
   `telemetry.upload` → `/api/telemetry/rum` and `/api/telemetry/forensics`;
   `soroban.submit` → `/api/soroban/footprint/inspect`. Transactions already
   on-ledger cannot be undone. Attribute them through the flag version
   recorded with each envelope.
2. **WS push (foreground, online):** a Redis `helphone:flags:v1` message
   becomes a `flags.patch` frame on `/events/ws`.
3. **Poll fallback:** `GET /api/flags` every 15 s with exponential backoff up
   to 5 min. It runs in background tabs and re-polls on `online` and
   visibility change.
4. **Tabs and workers:** the `helphone-flags` BroadcastChannel. Every worker
   in `src/workers/*` reads the shared snapshot directly, so it never waits on
   the main thread.

Offline semantics (`KILL_SWITCH_POLICIES` in `src/lib/featureFlags.ts`):

| Switch | TTL (fresh) | Max stale | When expired |
|---|---|---|---|
| `telemetry.upload` | 60 s | 24 h | fail closed |
| `soroban.submit` | 60 s | 5 min | **fail open**: blocking a rescue is worse; the server still enforces |
| `yjs.sync` | 60 s | 1 h | fail open |
| `mapbox.highres` | 60 s | 1 h | fail closed |
| `debug.verboseLogs` | 0 | 0 | fail closed (no flag can enable raw-PII logging) |

Unknown flags: old clients ignore them. Experiments default open, and a
known kill set to `false` wins.

Crash recovery: drafts store their `flagVersion`. `checkReplay(draft)` refuses
to resubmit a draft composed before a kill to a killed path, and the UI should
show "blocked by kill-switch".

Verify containment with `helphone_flag_version_reports_total{version,cohort}`
and `helphone_flag_time_to_effect_seconds`. Propagation p50/p95 per cohort
(foreground, background, intermittent, offline) still has to be measured in
the mixed-cohort Playwright drill. Until that is done, assume offline devices
adopt a kill only on reconnect, and rely on server enforcement.

---

## Map-Poison & Compromised Tile CDN Incident Runbook (ISP-092)

### 1. Threat & Detection
A compromised Mapbox CDN or adversarial proxy serving corrupted, manipulated, or opaque vector tiles threatens field responder routes and victim rescue coordinates.
- **Detection Triggers**:
  - `TILE_ANOMALY` events logged via `wsClient.ts`: opaque responses (status 0), non-protobuf MIME types (`text/html`, `application/json`), or oversized tiles (>1MB).
  - Anomaly threshold: ≥5 tile anomalies within 60s triggers immediate containment alert.

### 2. Immediate Containment (Drill Steps)
1. **Emit Upstream Tile Revocation**:
   - Edge proxy or backend CDN config injects `X-Tile-Revoke: true` header on all tile requests.
   - Alternatively, publish `TILE_REVOCATION` message across active WebSocket channels.
2. **Execute In-App Emergency Purge**:
   - Send `PURGE_TILES` postMessage to Service Worker:
     ```javascript
     navigator.serviceWorker.controller.postMessage({ type: "PURGE_TILES" });
     ```
   - Verifies all `tiles-v*` caches are deleted across all open tabs within <5s without purging precached app shell (`helphone-v1`) or offline ZK keys.
3. **Bump Tile Cache Generation**:
   - Update `TILES_CACHE_VERSION = "v2"` in `src/service-worker.js` and `vite.config.ts`.
   - On SW activation, old version caches (`tiles-v1`) are automatically evicted.
4. **Field Fallback**:
   - When CDN upstream is untrusted, switch `CommunityMap.jsx` to offline SVG fallback mode until new tileset hashes are attested.

