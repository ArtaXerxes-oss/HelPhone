# ADR-014: Binary Protocol Selection for Zero-Jank Telemetry Map Streams

| | |
|---|---|
| Status | Proposed (feasibility spike [#614](https://github.com/Hel-Phone/HelPhone/issues/614)) |
| Date | 2026-09-24 |
| Evidence | [Deserialization throughput & GC report](../spikes/614-binary-serialization-report.md) · raw data in [`docs/spikes/results/`](../spikes/results/) (`binary-serialization*.json`, `binary-conformance.json`) |
| Prototype | `src/schemas/telemetry.{fbs,capnp,proto}`, `src/utils/binaryParser.js`, `src/utils/binaryParserWasm.js`, `src/wasm/telemetry_reader/`, `src/components/TelemetryLab.jsx` (route `/lab/telemetry-bench`) |

## Context

High-frequency map updates (responder pins, trajectories, SOS requests) are sent as JSON. At the target of 10,000 objects per second, parsing them on the main thread was suspected of causing GC jank during pan and zoom. The spike compared JSON, Protocol Buffers, FlatBuffers and Cap'n Proto on the same schema. It measured CPU cost, heap allocation, GC pauses and dropped frames in Node and in Chrome (normal and 4× CPU-throttled), with JS and WASM readers that read fields straight from the ArrayBuffer.

## Decision

**Send live-map telemetry as FlatBuffers (`src/schemas/telemetry.fbs`, file identifier `HPTL`), and read it on the render path with zero-copy accessors that write into preallocated typed arrays. Never turn a frame into JS objects on the render path.**

1. **Wire format: FlatBuffers.** It is as fast as Cap'n Proto for this workload (both ~0.1 % of the main thread) and the same size. It wins on ecosystem: Google maintains the `flatbuffers` JS/TS runtime and `flatc --ts` codegen, which the Node server can use to encode, while Cap'n Proto's JS options are an early community package (`capnp-es` 0.0.x) or unmaintained ones. It also has a Rust implementation and a verifier for server-side validation. Cap'n Proto stays a viable alternative if a Rust/C++ service ends up producing the stream.
2. **Render path: `readFlatBuffersPositions()`** (hand-written, caches the shared vtable) fills id, kind, status, lat, lng and heading into typed arrays owned by the map layer. Everything else (popups, detail panels) uses the flyweight accessors or `flatc --ts` code on demand, one object at a time.
3. **Frame size: ≤ 1,000 objects per message (≥ 10 Hz at the target rate).** Smaller frames spread the work across animation frames; one 10,000-object frame is a 2 ms block with FlatBuffers but a 70–380 ms block with JSON.
4. **Keep JSON for low-rate APIs.** It is simple and debuggable, and its cost only matters at telemetry rates.
5. **Do not use the WASM reader.** It is correct and bounds-checked but not faster: the copy into linear memory cancels the gain. Keep it as a reference implementation only.
6. **Protobuf is not selected.** It is the smallest uncompressed (108 vs 164 B/object), but after deflate all formats are within 8 %. It cannot be read without scanning, and its object decoders allocate more than JSON.

## Rationale (i5-8265U laptop, Node 24 / Chrome 149; full tables in the report)

| Per object, 1,000-object frames at 10 Hz | JSON (today) | Protobuf streaming | FlatBuffers render path | Cap'n Proto render path |
|---|---:|---:|---:|---:|
| Decode time (Node) | 10.9 µs | 1.0 µs | **83 ns** | 53 ns |
| Main thread at 10k objects/s | 10.9 % | 1.0 % | **0.1 %** | 0.1 % |
| Heap allocated | 684 B | 0.7 B | **0.6 B** | 1.0 B |
| GC pauses (Node, per stream-second) | 0.20 (max 16 ms) | 0.10 | **0** | 0 |
| Dropped frames / 8 s, Chrome 4× throttled¹ | 129 (JSON → objects) | 6 | 13 | 4 |
| Read one field of one object | 6.8 ms (whole parse) | 3.6 ms | **4 µs** | 4 µs |

¹ Single run per scenario. Headless Chrome drops 1–5 frames per run even for the cheapest paths, so differences below ~10 frames are noise; the JSON and protobuf-object rows (129 and 155) are not.

- **The main cost of JSON is parse time, not GC.** V8 collects ~7 MB/s of JSON garbage with short minor GCs. The frames are lost to 7–11 µs per object of parsing (31–38 µs throttled), delivered in bursts the size of a frame.
- **Zero-copy only helps when nothing is materialised.** Decoding FlatBuffers or Cap'n Proto frames into objects allocates 770–1,030 B per object and costs as much as JSON.
- **The official FlatBuffers JS runtime is 7–10× slower** than the hand-written render-path reader (vtable lookups per field plus `ByteBuffer`), but allocates nothing and stays under 1 % of the main thread. That is why the render path gets the dedicated reader and everything else can use generated code.
- **Wire compatibility is verified:** our encoder's output decodes with `flatc`, `capnp` and `protoc`, and their output decodes with our readers (49/49 checks, including multi-segment Cap'n Proto messages). Protobuf output is byte-identical to `protoc --encode`.

## Alternatives considered

| Option | Outcome |
|---|---|
| Keep JSON, parse in a Web Worker | Viable stop-gap: moves the parse off the main thread. But the result must be copied back (structured clone of ~700 B per object, rebuilt as objects on the main thread) or re-encoded as typed arrays, which is the render-path format of this ADR anyway. |
| Protocol Buffers | Rejected for the stream (see Decision 6). Fine for request/response APIs if one is ever needed. |
| Cap'n Proto | Equivalent on the numbers (1.3–2× faster readers, same size); rejected on JS ecosystem maturity. Revisit if the producer is Rust/C++. |
| WASM (Rust) reader | Rejected: 1.2–1.9× slower than JS for FlatBuffers and 1.1–2.7× for Cap'n Proto, because of the copy into linear memory. |
| Official `flatbuffers` runtime on the render path | Rejected for the hottest loop only (7–10× slower); used everywhere else. |

## Consequences

**Positive**

- Decoding cost at the target rate drops from ~11 % to ~0.1 % of the main thread, and GC activity from the stream effectively disappears.
- Any object can be inspected in microseconds without decoding the frame.
- The payload is 46 % smaller before compression.

**Negative / risks**

- **Map code must consume typed arrays.** Mapbox GL's GeoJSON sources take objects; the stream needs a custom layer (or deck.gl-style attribute buffers) to benefit. That is the main integration work.
- **Untrusted input.** Readers bounds-check every access (`DataView` throws, WASM returns an error), but the JS runtime has no FlatBuffers verifier. The server must verify frames it relays, and clients must treat a `RangeError` as a dropped frame.
- **Schema evolution discipline.** Fields may only be appended, with explicit `(id: n)` attributes (already in the schema); `test/binary-parser.test.js` pins vtable slots to the `.fbs` file.
- **Debuggability.** Binary frames are opaque in DevTools. `flatc --json --raw-binary src/schemas/telemetry.fbs -- frame.hptl` decodes a captured frame.
- **Evidence quality.** One laptop with background load, and DevTools throttling instead of a phone. In Node, the ordering of formats was consistent across every repeat; the Chrome runs had one repeat each. Absolute numbers are approximate.

## Follow-up work (not in this spike)

1. Run `/lab/telemetry-bench` on a mid-range Android phone and Safari/iOS, and attach the numbers here before moving to Accepted.
2. Encode frames on the server (`server/`) with the official `flatbuffers` builder, verify on ingest, and send over WebSocket with `binaryType = "arraybuffer"`.
3. Add a map layer that consumes the position buffer directly (Mapbox custom layer or deck.gl), in `/help`.
4. Decide whether to keep the Cap'n Proto and Protobuf code paths as test fixtures or delete them once FlatBuffers is integrated.
