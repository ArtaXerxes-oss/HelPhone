# Telemetry and event delivery

## Distributed tracing

The backend starts the OpenTelemetry Node SDK before creating the Express app. HTTP and Express auto-instrumentation propagate W3C Trace Context. Requests carrying a valid `traceparent` receive an `x-trace-id` response header, and structured request logs include the same trace ID. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to an OTLP/HTTP collector to export traces; without it, instrumentation and propagation remain enabled but spans are not exported.

The React error boundary creates a W3C trace context for each captured render error and submits only the bounded error message and component stack to `POST /api/telemetry/errors`. The backend logs the trace ID with that report. Do not include wallet secrets, request form contents, or authentication tokens in client telemetry.

## Prometheus

`GET /metrics` uses Prometheus text exposition format. It includes the request counter and duration histogram plus `helphone_soroban_rpc_duration_seconds` and `helphone_zk_proof_duration_seconds`. Labels use route templates or fixed operation names; raw URLs, wallet addresses, and user IDs are never labels. Set `METRICS_BEARER_TOKEN` when the endpoint is reachable from outside a private monitoring network.

## WebSocket event relay

`GET /events/ws` upgrades to WebSocket. The relay supports the request lifecycle topics and responds to a `subscribe` message with an acknowledgement. A validated `tenant` query parameter filters events that include a matching tenant ID; events without a tenant ID are not sent to tenant-filtered clients. Heartbeats remove dead connections, and clients exceeding the bounded send buffer are disconnected.

When `REDIS_URL` is configured, events are published on `helphone:contract-events:v1` and each server process fans them out to its local sockets. A short Redis `SET NX` marker deduplicates event IDs produced by multiple pollers. Without Redis, the relay works within one process only. `node server/tests/ws-cluster.js` opens 1,000 clients across the three URLs supplied in `WS_CLUSTER_URLS` to exercise a deployed cluster.

## Trace propagation contract (#791)

One dispatch keeps one `traceId` from the tap to the ledger.

| Hop | Carrier | Code |
|-----|---------|------|
| PWA → HTTP | `traceparent` header (`traceHeaders()`) | `src/lib/telemetry.ts` |
| Main thread → worker | `__traceVersion` + `__traceparent` message fields (`wrapForWorker` / `unwrapFromWorker`) | `src/lib/telemetry.ts` |
| Crash dump | `traceId` / `spanId` on the IDB draft | `src/lib/crashRecovery.ts` |
| Redis pub/sub | `trace: { v: 1, traceparent, tracestate? }` in the JSON message | `server/lib/redisPubSub.js`, `server/lib/traceContext.js` |
| Ledger → indexer | `traceparent` recorded off-chain at submit time, copied onto the audit row with `helphone.dispatch_id`, `stellar.tx_hash` and `stellar.ledger_seq` | `server/indexer/auditStreamer.js` |

Rules:
- Each hop sends a child `traceparent`: the traceId stays the same and the spanId is new.
- Fan-out receivers (Redis subscribers, indexer) record the publisher span as a **link**, not a parent.
- If a message arrives without `trace`, nothing is attached. Don't start a new trace at poll time. Old publishers and workers keep working, so a rollback is safe for one release.

The browser-side carriers live in `src/lib/telemetry.ts` (`traceHeaders`,
`wrapForWorker`, `unwrapFromWorker`, `currentTraceIds`) and are backed by the
dependency-free W3C helpers in `src/lib/traceWire.js`. `crashRecovery.ts` uses
`currentTraceIds()` for the IDB draft and the flag-version helpers from
`src/lib/featureFlags.ts` for stale replay checks. Server-side fan-out links
are produced in `server/lib/redisPubSub.js` and joined onto audit rows in
`server/indexer/auditStreamer.js` via `hopContext()` from `traceContext.js`.
`node --test test/trace-propagation.node-test.mjs` follows one traceId through
every hop and asserts the no-trace rollback rule.

```
PWA tap ──traceparent──▶ Express ──trace{}──▶ Redis ──▶ subscriber (link)
   │                         │
   └─ worker (__traceparent) └─ Soroban submit ─(txHash↔traceparent, off-chain)─▶ indexer row
```

### Sampling and quotas (#759)

The OTel Node SDK is configured at boot by `server/telemetryBootstrap.js`, which
builds an `OtelSamplingEngine` and registers it with `server/telemetry.js`.
Sampling is hybrid:

- The SDK sampler applies Pareto noise rules first (`/healthz`, `/readyz`,
  static assets, heartbeats). Those spans are `NOT_RECORD` — no span is allocated.
- Every other span is `RECORD_ONLY`. `createTailSamplingExporter` makes the
  final decision when the span ends, so an error or P0 path discovered late is
  never lost to quota exhaustion.
- Priority rules run before quotas: 100% of errors, `emergency_dispatch` flows,
  `helphone.p0` spans and spans at or above the latency threshold are kept.
- Per-tenant quotas (`tenantQuotas`) gate background traffic. Exhaustion
  degrades the tenant to `DROP`/`RECORD_ONLY`; errors and P0 paths continue.

Configuration (all optional, documented defaults):

| Variable | Default | Meaning |
|---|---|---|
| `OTEL_HEAD_SAMPLE_RATIO` | `0.05` | Baseline background sample ratio |
| `OTEL_DEFAULT_TENANT_QUOTA` | head ratio | Quota for tenants without an explicit entry |
| `OTEL_TENANT_QUOTAS` | `{}` | JSON map of tenant id → ratio, e.g. `{"tenant-a":0.01}` |
| `OTEL_HIGH_LATENCY_THRESHOLD_MS` | `1000` | Slow spans are always kept |
| `OTEL_EXPORTER_BACKOFF_MS` | `30000` | Circuit-breaker window after an OTLP `429` |
| `OTEL_PII_SALT` | built-in | Salt for pseudonymising wallet/IP/responder identifiers |
| `OTEL_P0_PATHS` | dispatch/help/error ingest | Comma-separated regexes for P0 routes |

Drop counters are exported on `GET /metrics`:
`helphone_otel_spans_dropped_total{stage="head",reason=...}`,
`helphone_otel_spans_exported_total`,
`helphone_otel_spans_final_kept_total`,
`helphone_otel_spans_final_dropped_total`,
`helphone_otel_spans_rescued_total`,
`helphone_otel_tenant_quota_exhausted_total{tenant=...}` (top 20 tenants, rest
aggregated as `tenant="other"`) and `helphone_otel_exporter_circuit_active`.
Tenant labels and drop reasons are bounded so quota exhaustion cannot create a
cardinality incident.

## Redaction (#792)

Logs, traces, indexer rows and exports go through `server/lib/redact.js`:
- phone, contact and name become `hmac:<16hex>` (`PII_HMAC_SALT`, shared by all sinks so joins still work);
- coordinates are rounded to 3 decimals;
- notes and memo become `[redacted:<len>]`.

Morgan logs `:redacted-url`. `node scripts/security/env_firewall.js --scan <file>` fails if it finds PII.

## Heap forensics and measurability matrix (#793)

`src/lib/heapForensics.ts` samples per-subsystem memory proxies into a fixed 50-entry census (`CENSUS_SIZE = 50`) backed by a single preallocated `Float64Array(50 * 15)` (`SELF_BYTES = 6000`). Both sampling (`sample()`) and envelope construction (`buildEnvelope()` / `readCensusMatrix()`) reuse preallocated row views so emitting a memory-pressure envelope allocates no per-sample objects.

Every probe is wrapped in a non-throwing guard (`safe()`): when a browser or runtime lacks an API (for example, `performance.memory` outside Chromium, `performance.measureUserAgentSpecificMemory` without cross-origin isolation, or `navigator.storage.estimate` in restricted contexts), the probe records `NaN` in the `Float64Array` census (serialized as `null` in `helphone.forensics/1` JSON envelopes) and never throws. When `performance.measureUserAgentSpecificMemory()` is supported (`COOP: same-origin` + `COEP: credentialless`), `probeUaSpecificMemory()` populates the cross-origin isolated byte measurement and triggers pressure evaluation when memory usage crosses the pressure threshold.

### Measurability matrix

| Signal | Kind (`SIGNAL_KIND`) | Source / Probe | Browser & Runtime Availability | Missing API Behavior |
|--------|----------------------|----------------|--------------------------------|----------------------|
| `ts` | timestamp | `Date.now()` | All runtimes | `NaN` if non-finite |
| `jsHeapUsed` | `measured` | `performance.memory.usedJSHeapSize`, falling back to `performance.measureUserAgentSpecificMemory()` | Chromium (`performance.memory`) or COOP/COEP isolated UAs (`measureUserAgentSpecificMemory`) | `NaN` (`null` in JSON) |
| `jsHeapLimit` | `measured` | `performance.memory.jsHeapSizeLimit` | Chromium main thread | `NaN` (`null` in JSON) |
| `workerQueueDepth` | `measured` | `recordWorkerQueue(depth, pendingBytes)` via `workerSupervision.js` heartbeats | All workers with supervision hooks | `0` (counter default) |
| `workerPendingBytes` | `estimate` | Sum of structured-clone payload byte estimates from supervised workers | All workers with supervision hooks | `0` (counter default) |
| `workerHeartbeatAgeMs` | `proxy` | `now - lastHeartbeat` from `recordWorkerHeartbeat()` | Main thread supervising workers | `NaN` before first beat |
| `yjsBytes` | `estimate` | `subsystems.yjsDoc.encodeState().byteLength` | Sessions with active CRDT document | `NaN` when unattached |
| `mapboxTiles` | `measured` | Tile count across `subsystems.map.style.sourceCaches[*]._tiles` | Sessions with mounted Mapbox GL instance | `NaN` when unmounted |
| `mapboxStyleBytes` | `estimate` | `JSON.stringify(subsystems.map.getStyle()).length` | Sessions with mounted Mapbox GL instance | `NaN` when unmounted |
| `ringBytes` | `measured` | `counters.ringBytes + SELF_BYTES` (fed by `RingBuffer` and `createAuditTape`) | All runtimes | `SELF_BYTES` (`6000`) |
| `wasmBytes` | `measured` | `subsystems.wasmMemory().buffer.byteLength` | Runtimes with loaded WASM linear memory | `NaN` when unattached |
| `wasmGrowEvents` | `measured` | `instrumentWasmMemory(memory)` wrapper on `WebAssembly.Memory.prototype.grow` | Runtimes with instrumented WASM memory | `0` (counter default) |
| `parserAllocBytes` | `measured` | `recordParserAlloc(bytes)` in `src/utils/binaryParserWasm.js` | WASM telemetry parser path | `0` (counter default) |
| `storageUsage` | `estimate` | `navigator.storage.estimate().usage` | StorageManager-capable browsers | `NaN` (`null` in JSON) |
| `storageQuota` | `estimate` | `navigator.storage.estimate().quota` | StorageManager-capable browsers | `NaN` (`null` in JSON) |

### Pressure triggers, metrics, and incident bundle attachment

- **Pressure reasons (`PressureReason`)**:
  - `heartbeat_stall`: `workerHeartbeatAgeMs > 30_000`
  - `heap_near_limit`: `jsHeapUsed / jsHeapLimit > 0.85` (or `jsHeapUsed > DEFAULT_UA_MEMORY_PRESSURE_BYTES` when `jsHeapLimit` is `NaN` under `measureUserAgentSpecificMemory`, or on `RingBuffer` critical pressure)
  - `storage_near_quota`: `storageUsage / storageQuota > 0.90`
  - `crash`: `emergencyEmit()` from `ErrorBoundary` / crash recovery (skips retainer hints for OOM safety)
  - `manual`: operator snapshot from `TelemetryLabPanels` or `window.__helphone_forceHeapSnapshot()`
- **Server ingest & Prometheus metrics**: `POST /api/telemetry/forensics` validates against `forensicEnvelopeSchema` (`schema: "helphone.forensics/1"`, up to 50 census rows) and exports `helphone_forensic_envelopes_total{reason,ua}` and `helphone_forensic_subsystem_bytes{subsystem,ua}`.
- **Incident bundle**: `scripts/helphone-bundle.js` (and `attachForensicsToIncidentBundle()`) attaches the fixed 50-entry census envelope at `client/heap-forensics.json`, carrying sizes and counts only (zero PII).

## Incident tape and clock semantics (#794)

| Source | Field | Clock | Trust |
|--------|-------|-------|-------|
| Ledger events | `closeTime` | Stellar consensus, 5 s granularity | Authoritative |
| Server logs | `ts` | NTP-synced server wall clock, UTC ISO | High |
| OTel spans | `startTime` | Emitting process clock; ingest delay is recorded separately (`ingestDelayMs`) | Medium |
| Client ring and crash dumps | `ts` / `mono` | Device wall clock, which can be minutes off | Low until corrected |

`GET /api/time` and `estimateClockOffset()` give a Cristian offset (±RTT/2). `scripts/build-incident-tape.js` adds that offset to each source's times. Ledger events keep their own time. Events whose times are within each other's error margin are ordered by `ledgerSeq`, and then by monotonic order within the same device. Each output event has `tCorrected`, `tConfidenceMs`, `source` and `causalSeq`. The output is scrubbed by default; `--include-raw` is a break-glass option and is logged.

## Transport field telemetry (#913, ADR-003 follow-up 3)

The `createNetworkTransport()` instance exposes an `emitTelemetry(pipeline)` method that snapshots `getMetrics()` and records a `transport.field_metrics` span with priority `low`.  Call it on `visibilitychange → hidden` or after each transport fallback / QUIC migration event so the field dashboard captures UDP-block rates and migration-survival ratios without polling overhead.

### Emitted span attributes

| Attribute | Type | Bounded by | Purpose |
|---|---|---|---|
| `transport.reconnect_gaps_ms` | `number[]` | last 20 entries; each ≤ 300 000 ms | Distribution of reconnect gap durations; feeds UDP-block-rate dashboard |
| `transport.reconnect_gap_p50` | `number` | derived | p50 reconnect gap in ms |
| `transport.reconnect_gap_max` | `number` | derived | Maximum gap in ms this session |
| `transport.fallbacks` | `number` | session counter | WebTransport → WebSocket → SSE downgrades |
| `transport.failures.webtransport` | `number` | capped at 100 | Consecutive WebTransport failures; high values indicate UDP-blocked network |
| `transport.migrations_survived` | `number` | session counter | QUIC connection migration successes (network interface switches that did not drop the stream) |
| `transport.connects` | `number` | session counter | Total successful connects across all transport types |

### PII / redaction contract

- No IP addresses, user IDs, wallet addresses, or message content enter the span.
- `reconnect_gaps_ms` is capped at **20 entries** so long sessions cannot grow the payload.
- Each gap value is clamped to **300 000 ms** (5 min) to prevent outlier values from fingerprinting a user's network event sequence.
- `failures.webtransport` is capped at **100** to prevent large counters encoding information.
- The span carries no location data; the `TelemetryRedactor` drop-list therefore has nothing to redact from it.

### Field dashboard metrics

| Dashboard metric | Derived from |
|---|---|
| UDP-block rate | `transport.failures.webtransport` ≥ `maxFailures` (2) across the fleet |
| Migration survival rate | `transport.migrations_survived / transport.connects` |
| Reconnect P50 / P95 | `transport.reconnect_gaps_ms` aggregated server-side |

### Integration example

```ts
// Wire into app lifecycle — emit on hide to avoid extra traffic.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    transport.emitTelemetry(telemetryPipeline)
  }
})

// Also emit after each fallback for real-time alerting.
const t = createNetworkTransport({
  endpoints,
  onStatus: ({ state, transport: kind, reason }) => {
    if (reason === 'fallback') {
      t.emitTelemetry(telemetryPipeline)
    }
  },
})
```

### Implementation files

| File | Role |
|---|---|
| `src/lib/transportTelemetry.ts` | `buildTransportAttributes`, `emitTransportTelemetry`, bounding constants |
| `src/services/networkTransport.js` | `emitTelemetry(pipeline)` method on the transport instance |

## Binary map frames (ADR-014 follow-up; this PR)

In addition to the tracing/pipeline above, the live map can carry high-rate
position updates as FlatBuffers frames. The two systems are independent: the
OTel pipeline handles spans and forensics, while this path handles map objects.

```
producer
  └─ encodeTelemetryFrame()            src/lib/telemetryFrame.js
       └─ flatbuffers.Builder → HPTL Uint8Array (≤1000 objects, 1 MiB cap)
  └─ createFrameEncoder()              server/telemetry.js
       └─ 30 frames/s budget; RangeError → dropped frame
  └─ attachTelemetryWebSocket()        server/telemetry.js
       └─ binary WS at /api/events/frame-stream (+ HTTP fallback ingest)
consumer
  └─ createTelemetryClient()           src/lib/telemetry.ts
       ├─ WebSocket.binaryType = 'arraybuffer'
       └─ verifyFrame() → drop malformed without throwing
  └─ TelemetryBuffers.ingest()         src/lib/telemetryBuffers.ts
       └─ id/kind/status/lat/lng/heading straight into typed arrays
  └─ createTelemetryLayer()            src/lib/telemetryLayer.ts
       └─ Mapbox custom layer; JSON path only for popups/details
```

Low-rate APIs (`/api/events/ice-config`, `/api/events/ice-metrics`,
`/api/events/frames/config`) stay JSON. The schema is
`src/schemas/telemetry.fbs`; the checked-in accessors are
`src/schemas/telemetry_generated.js`. Conformance: `npm run test:telemetry:frames`
(49 wire-format checks). Jank benchmark: `npm run bench:telemetry-jank`.
