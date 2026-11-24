# ADR-014: Binary telemetry frames for the live map

**Status:** Accepted · **Owner:** @helphone-telemetry-owner / @helphone-maps-owner
**Related:** follow-up 2 (server encoder + ingest verification), follow-up 3 (typed-array map layer)

## Context

The live map was streaming every responder position as a JSON object. At incident
peak that means tens of thousands of short-lived objects per second on the main
thread, plus a full structured clone per WebSocket message. The storage spike
(#607) showed the same object-churn pattern on the write path. We need a wire
format that is compact, self-describing enough to reject garbage safely, and
cheap to consume without materialising JS objects.

## Decision

1. **Wire format.** A FlatBuffers schema (`src/schemas/telemetry.fbs`) with
   root table `Frame`, a vector of `TrackedObject` records and the file
   identifier `HPTL`. Schema version is carried in the frame itself.
2. **Encoding.** The server builds frames with the official `flatbuffers`
   Builder. A frame holds at most **1,000** objects; a larger request is a
   dropped frame. `RangeError` from the codec is always converted into a drop.
3. **Budgets.** 1 MiB per frame and 30 frames/s per connection are enforced in
   `server/telemetry.js`; clients discover them via a JSON config endpoint.
4. **Ingest.** Every inbound binary frame is verified
   (`verifyFrame` → `{ok, error}`) before it reaches a subscriber. Verification
   never throws on the main path and checks identifier, root/vtable bounds,
   vector bounds and object field bounds.
5. **Transport.** The WebSocket endpoint `/api/events/frame-stream` sends binary
   frames. Clients set `WebSocket.binaryType = 'arraybuffer'`. Low-rate APIs
   (ICE config/metrics, popups, request details) stay JSON. An HTTP POST
   fallback accepts the same binary bytes.
6. **Rendering.** `src/lib/telemetryBuffers.ts` decodes frames directly into
   preallocated typed arrays (`id`, `kind`, `status`, `lat`, `lng`, `heading`).
   A Mapbox custom layer (`src/lib/telemetryLayer.ts`) reads those arrays as
   WebGL attributes. Plain objects exist only for the JSON popup/details path.

## Alternatives considered

- **Protobuf / msgpack:** smaller than JSON but still requires per-record
  decoding into objects on the client. FlatBuffers' in-place access lets us
  skip that allocation entirely.
- **JSON + shared worker:** moves the cost off-thread but still clones objects
  at the boundary and complicates popups, which need plain objects anyway.

## Consequences

- The conformance suite (`npm run test:telemetry`) pins 49 wire-format checks,
  including malformed-frame rejection and both budgets.
- `flatc` can decode any emitted frame with `src/schemas/telemetry.fbs` (run
  `flatc --json --strict-json --raw-binary telemetry.fbs -- <frame>`).
- Schema changes require bumping `SCHEMA_VERSION`; old frames are then rejected
  rather than silently misread.
- Benchmark: `npm run bench:telemetry-jank` writes
  `docs/benchmarks/telemetry-jank-report.json` (10k objects/s, 25 frames/s).

## Checklist

- [x] Conformance suite 49/49
- [x] Malformed frames rejected without throwing
- [x] Frame-size and rate budgets enforced
- [x] `binaryType = 'arraybuffer'` on the client
- [x] JSON retained for low-rate APIs
- [x] Typed-array custom layer with a JSON popup path
