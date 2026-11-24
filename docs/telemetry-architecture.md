# Telemetry architecture

See [ADR-014](adr/ADR-014-telemetry-binary-frames.md) for the decision and
evidence. This document is the implementation map.

## Flow

```
producer (server / worker)
  └─ encodeTelemetryFrame(objects, {tsSec, seq})   src/lib/telemetryFrame.js
       └─ flatbuffers.Builder → Uint8Array (HPTL, ≤1000 objects, 1 MiB cap)
  └─ createFrameEncoder()                          server/telemetry.js
       └─ 30 frames/s budget; RangeError → dropped frame
  └─ attachTelemetryWebSocket()                    server/telemetry.js
       └─ binary WS frames at /api/events/frame-stream

consumer (browser)
  └─ createTelemetryClient()                       src/lib/telemetry.ts
       ├─ WebSocket.binaryType = 'arraybuffer'
       ├─ verifyFrame() → drop malformed, never throw
       └─ onFrame(frame)
  └─ TelemetryBuffers.ingest()                     src/lib/telemetryBuffers.ts
       └─ writes id/kind/status/lat/lng/heading straight into typed arrays
  └─ createTelemetryLayer()                        src/lib/telemetryLayer.ts
       └─ Mapbox custom layer uploads positions as WebGL attributes
  └─ buffers.get(i)                                JSON path: popups / details only
```

## Low-rate JSON APIs

`/api/events/ice-config`, `/api/events/ice-metrics`, `/api/events/frames/config`
and `/api/events/frames` (HTTP fallback ingest) remain JSON/binary-over-HTTP.
They are never used for high-rate position updates.

## Files

| Path                                     | Role                                                           |
| ---------------------------------------- | -------------------------------------------------------------- |
| `src/schemas/telemetry.fbs`              | Canonical FlatBuffers schema (`HPTL`)                          |
| `src/schemas/telemetry_generated.js`     | Checked-in generated-style accessors + zero-allocation helpers |
| `src/lib/telemetryFrame.js`              | Encode / verify / decode / summary                             |
| `server/telemetry.js`                    | Budgets, ingest verification, WebSocket broadcast              |
| `server/routes/events.js`                | JSON discovery + binary HTTP fallback                          |
| `src/lib/telemetry.ts`                   | Client transport (`binaryType = 'arraybuffer'`)                |
| `src/lib/telemetryBuffers.ts`            | Preallocated typed arrays                                      |
| `src/lib/telemetryLayer.ts`              | Mapbox custom layer                                            |
| `src/components/TelemetryLayer.tsx`      | React adapter for the custom layer                             |
| `test/telemetry-conformance.test.js`     | 49-check wire-format suite                                     |
| `scripts/bench/telemetry-jank-bench.mjs` | 10k objects/s jank comparison                                  |

## Commands

```bash
npm run test:telemetry          # conformance + transport tests
npm run bench:telemetry-jank    # writes docs/benchmarks/telemetry-jank-report.json
```

To regenerate accessors with the official compiler:

```bash
flatc --js -o src/schemas src/schemas/telemetry.fbs
```
