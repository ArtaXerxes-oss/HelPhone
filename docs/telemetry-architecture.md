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

```
PWA tap ──traceparent──▶ Express ──trace{}──▶ Redis ──▶ subscriber (link)
   │                         │
   └─ worker (__traceparent) └─ Soroban submit ─(txHash↔traceparent, off-chain)─▶ indexer row
```

## Redaction (#792)

Logs, traces, indexer rows and exports go through `server/lib/redact.js`:
- phone, contact and name become `hmac:<16hex>` (`PII_HMAC_SALT`, shared by all sinks so joins still work);
- coordinates are rounded to 3 decimals;
- notes and memo become `[redacted:<len>]`.

Morgan logs `:redacted-url`. `node scripts/security/env_firewall.js --scan <file>` fails if it finds PII.

## Incident tape and clock semantics (#794)

| Source | Field | Clock | Trust |
|--------|-------|-------|-------|
| Ledger events | `closeTime` | Stellar consensus, 5 s granularity | Authoritative |
| Server logs | `ts` | NTP-synced server wall clock, UTC ISO | High |
| OTel spans | `startTime` | Emitting process clock; ingest delay is recorded separately (`ingestDelayMs`) | Medium |
| Client ring and crash dumps | `ts` / `mono` | Device wall clock, which can be minutes off | Low until corrected |

`GET /api/time` and `estimateClockOffset()` give a Cristian offset (±RTT/2). `scripts/build-incident-tape.js` adds that offset to each source's times. Ledger events keep their own time. Events whose times are within each other's error margin are ordered by `ledgerSeq`, and then by monotonic order within the same device. Each output event has `tCorrected`, `tConfidenceMs`, `source` and `causalSeq`. The output is scrubbed by default; `--include-raw` is a break-glass option and is logged.
