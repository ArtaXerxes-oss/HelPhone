# Feasibility Spikes #604–#607

These four time-boxed spikes each produce an ADR (in [`docs/adr/`](../adr/README.md)), a report with the measured evidence, a working prototype under `src/`, unit tests under `test/`, and a reproducible benchmark under `scripts/spikes/`. The prototypes are **not wired into the app UI**; the ADRs list the integration follow-ups.

| Spike | ADR | Report | Prototype | Benchmark | Raw data |
|---|---|---|---|---|---|
| #604 CRDT vs OT memory | [ADR-004](../adr/ADR-004-offgrid-map-sync.md) | [604 report](604-crdt-memory-analysis.md) | `src/services/crdtSync.js` | `scripts/spikes/crdt_memory_profile.js` | [json](results/crdt-memory-profile.json) |
| #605 Noir recursive aggregation | [ADR-005](../adr/ADR-005-zk-proof-aggregation.md) | [605 report](605-zk-circuit-complexity-benchmark.md) | `circuits/responder_credential`, `circuits/recursive_verifier`, `src/utils/zkProver.js` | `scripts/spikes/zk_aggregation_benchmark.js` | [json](results/zk-aggregation.json) |
| #606 Offline routing | [ADR-006](../adr/ADR-006-offline-routing.md) | [606 report](606-routing-benchmark-report.md) | `src/utils/graphTraversal.js`, `src/workers/routingWorker.js` | `scripts/spikes/routing_benchmark.js` | [json](results/routing-benchmark.json) |
| #607 Storage lock contention | [ADR-007](../adr/ADR-007-offline-storage.md) | [607 report](607-storage-lock-contention-report.md) | `src/services/storageEngine.js`, `src/workers/telemetryWorker.js` | `scripts/spikes/storage_contention_benchmark.js` | [json](results/storage-contention.json) |
| #614 Binary serialization (FlatBuffers vs Cap'n Proto) | [ADR-014](../adr/ADR-014-binary-telemetry-protocol.md) | [614 report](614-binary-serialization-report.md) | `src/utils/binaryParser.js`, `src/utils/binaryParserWasm.js`, `src/wasm/telemetry_reader/` | `scripts/spikes/binary_serialization_benchmark.js`, `binary_browser_benchmark.js` | [node](results/binary-serialization.json), [chrome](results/binary-serialization-browser.json), [chrome 4×](results/binary-serialization-browser-cpu4x.json) |
| #758 Zero-Downtime Deploy Choreography | — | [758 report](758-zero-downtime-deploy-report.md) | `server/lib/zeroDowntimeDeploy.js` | — | — |
| #759 OTel Sampling & Quota Protection | — | [759 report](759-otel-sampling-quota-report.md) | `server/lib/otelSamplingEngine.js` | — | — |
| #760 Zero-Downtime Secrets Rotation | — | [760 report](760-secrets-rotation-report.md) | `server/lib/secretRotationManager.js` | — | — |
| #761 Anti-Spoofing & ZK Credential Replay Defense | — | [761 report](761-anti-spoof-geofence-report.md) | `server/lib/antiSpoofVerification.js` | — | — |
| #762 PWA Cache Poisoning & Map Tile Integrity | — | [762 report](762-pwa-cache-poisoning-tile-report.md) | `server/lib/tileCacheIntegrity.js`, `src/service-worker.js` | — | — |
| #763 Dependency Confusion & Build-Tag Protection | — | [763 report](763-dependency-confusion-sqlite-wasm-report.md) | `scripts/security/dependencyConfusionGuard.js` | — | — |
| #764 Build-Egress Exfiltration Defense | — | [764 report](764-build-egress-exfiltration-report.md) | `scripts/security/buildEgressGuard.js`, `scripts/audit-ai-code.js` | — | — |
| #766 Right-to-be-Forgotten Data Purge | — | [766 report](766-right-to-be-forgotten-purge-report.md) | `server/lib/dataPurge.js` | — | — |
| #767 WCAG 2.2 AA Screen-Reader Hardening | — | [767 report](767-wcag-screen-reader-hardening-report.md) | `src/components/MapAccessibleAlternative.jsx`, `src/lib/focusTrap.js`, `src/lib/a11yMotion.js` | — | — |
| #768 12-Hour Shift Battery & Thermal | — | [768 report](768-battery-thermal-field-responder-report.md) | `src/lib/powerManager.js` | — | — |
| #769 Multi-Fault Chaos & Bulkhead Design | — | [769 report](769-multi-fault-chaos-bulkhead-report.md) | `server/lib/chaosEngine.js` | — | — |
| #783 BLE proximity relay (prototype only, no hardware measurements) | [ADR-022](../adr/ADR-022-ble-proximity-relay.md) | [783 report](783-ble-gossip-report.md) | `src/lib/bleRelay.ts` | — | — |

## Measurement environment

All numbers come from one machine, a deliberately modest one: **Intel Core i5-4300U** (2014, 2 cores / 4 threads, 1.9 GHz), 11.6 GB RAM, Linux, Node 22.22, Chromium 147.0.7727.15 (Playwright build 1217). **No phone was measured.** Where a report extrapolates to mobile, it says so and names the assumption.

## Reproducing

```bash
npm ci --legacy-peer-deps           # adds yjs, @sqlite.org/sqlite-wasm, fake-indexeddb (dev only)

npm run spike:routing               # ~15 min (13 of them CH preprocessing; add --skip-ch to skip)
npm run spike:crdt                  # ~2 min
CHROMIUM_PATH=/path/to/chrome npm run spike:storage   # ~12 min, drives Chromium via Playwright
# optional, not yet run: emulate a CPU-starved device / re-run the quota tests
node scripts/spikes/storage_contention_benchmark.js --cpu-stress 4 --only idb/,sqlite-sahpool/owner
node scripts/spikes/storage_contention_benchmark.js --only quota/

# ZK: nargo 1.0.0-beta.9 is required to (re)build circuits; bb.js runs the prover
NARGO=/path/to/nargo npm run spike:zk:build
npm run spike:zk                    # tens of minutes (N=5 single-threaded proving)
```

The unit tests (`npm test`) cover the prototype logic without WASM proving or a browser.
