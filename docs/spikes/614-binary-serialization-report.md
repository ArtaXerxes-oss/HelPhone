# Spike #614: Deserialization Throughput & GC Report

Feeds [ADR-014](../adr/ADR-014-binary-telemetry-protocol.md). Raw data: [`results/binary-serialization.json`](results/binary-serialization.json) (Node), [`results/binary-serialization-browser.json`](results/binary-serialization-browser.json) and [`results/binary-serialization-browser-cpu4x.json`](results/binary-serialization-browser-cpu4x.json) (Chrome), [`results/binary-conformance.json`](results/binary-conformance.json) (wire compatibility).

## Question

Live-map updates (responder pins with trajectories, SOS requests) arrive as JSON. Parsing it creates garbage that the GC must collect while the user pans and zooms. At the target of **10,000 objects per second**, how much main-thread time and GC activity does each format cost: JSON, Protocol Buffers, FlatBuffers and Cap'n Proto? And can the zero-copy formats be read straight from the ArrayBuffer, in JS or WASM, without building objects?

## What was built

| File | Purpose |
|---|---|
| `src/schemas/telemetry.fbs`, `.capnp`, `.proto` | One logical schema in three IDLs: `TelemetryFrame { seq, sent_at_ms, objects: [MapObject] }`. A `MapObject` has 11 scalars (id, kind, status, priority, lat/lng as degrees × 1e6 like the Soroban contract, heading, speed, ETA, request id, timestamp), 2 strings (emergency type, responder G-address) and a trail of up to 8 recent positions as int32 deltas. No 64-bit integers, because JS readers turn those into allocating `BigInt`s. |
| `src/utils/binaryParser.js` | Encoders and dependency-free readers for all four formats. Three access levels: `readPositions()` (render path into preallocated typed arrays), flyweight accessors (`frame.object(i, reuse)`) and `decodeFrame()` (plain objects). The Cap'n Proto reader follows far and double-far pointers across segments. |
| `src/wasm/telemetry_reader/` → `src/wasm/telemetry_reader.wasm` | 2.9 KB `no_std` Rust reader for the FlatBuffers and Cap'n Proto render path. Every read is bounds-checked. The SHA-256 sidecar is pinned by a test. JS wrapper: `src/utils/binaryParserWasm.js`. |
| `scripts/spikes/binary_conformance.js` | Wire compatibility against the official toolchains in both directions (below). |
| `scripts/spikes/binary_serialization_benchmark.js` | Node benchmark: one child process per scenario, `v8.GCProfiler` for every GC, plus a real-time paced phase. |
| `src/utils/telemetryBench.js`, `scripts/spikes/binary_browser_benchmark.js` | Chrome benchmark: rAF loop that decodes and plots every object. GC pauses come from a DevTools trace (`MinorGC` / `MajorGC` on the renderer main thread). Also mounted as the `/lab/telemetry-bench` route, for repeating the run on phones. |
| `test/binary-parser.test.js` | 37 tests: round trips, edge values, zero-copy views, far pointers, truncated/corrupt input, WASM parity, schema-layout pinning. |

### Wire conformance (49/49 checks pass)

| Format | Ours → official | Official → ours |
|---|---|---|
| FlatBuffers | `flatc --json` (2.0.8) and the `flatbuffers` 25.9.23 JS runtime with `flatc --ts` readers decode our buffers | `flatc --binary` output (back-to-front layout, defaults omitted) is read by our decoder, `readPositions` and the WASM reader |
| Cap'n Proto | `capnp convert binary:json` (1.0.1) decodes our messages | `capnp convert json:binary` output, **4 segments with far pointers** for 500 objects, is read by all three readers |
| Protobuf | **byte-identical** to `protoc --encode` (3.21); `protobufjs` 8.8.0 decodes it | `protoc` and `protobufjs` output decodes identically |

Cases: an empty frame, edge values (±90°/±180° with negative coordinates, `u32` max, `2^53 − 1` timestamps, `i32` min/max trail deltas, non-ASCII text), 12 objects and 500 objects.

## Method

- **Stream:** 10,000 objects/s delivered as frames of 100, 1,000 or 10,000 objects (100 Hz, 10 Hz, 1 Hz). 30 % are SOS requests; 70 % are responders with 8-point trails. Every frame arrives as a **newly allocated ArrayBuffer** (`slice()`), as it would from WebSocket or `fetch`. The last decoded frame stays alive until the next one arrives, as map state would.
- **Access patterns:**
  - `positions` is the render path: id, kind, status, lat, lng and heading into reused typed arrays.
  - `fields` reads every scalar and every trail value through a reused flyweight, but no strings.
  - `materialize` builds plain objects for everything, which is what `JSON.parse` gives you today.
  - `flyweight-positions` reads the positions fields through the flatc-style flyweight, which resolves the vtable on every field access.
  - `flatbuffers-official` uses the `flatbuffers` npm runtime with `flatc --ts` code.
  - `protobufjs` is the protobufjs runtime.
- **Node:** v24.13.1 (V8 13.6), 20 s of stream per run, unpaced, then 6 s paced at real time with a 60 Hz tick, 2 interleaved repeats. Tables show medians, with the min–max spread of ns/object in brackets. Readers are warmed to TurboFan before measuring. A forced GC deoptimises them ("embedded weak objects cleared"), so the harness re-warms after it.
- **Chrome:** 149 headless, cross-origin isolated (5 µs timers), 8 s per run, 1 repeat. Each rAF callback decodes whatever frames are due and plots every object into a canvas. `--cpu-throttle 4` (DevTools CPU throttling) stands in for a mid-range phone.
- **Machine:** Intel i5-8265U (4 cores / 8 threads, 1.6 GHz base), 7.4 GB RAM, Linux, on AC power. **It was not quiet:** load average 4–6 from a desktop browser, VS Code and another agent; memory was nearly full. An earlier attempt was killed by memory pressure and discarded. Read small differences (< 1.5×) as noise; the spreads in the tables show how much.

Reproduce: `npm run spike:binary`, `npm run spike:binary:browser` (set `CHROMIUM_PATH`), `npm run spike:binary:conformance` (needs `flatc`, `capnp` and `protoc` on PATH, plus `--libs <node_modules with flatbuffers and protobufjs>` for the official-runtime rows). The runs used here: `--seconds 20 --paced-seconds 6 --repeats 2` and `--seconds 8 --repeats 1`.

## Results

### Size per object

| Format | Bytes / object | After deflate (WebSocket `permessage-deflate`) |
|---|---:|---:|
| JSON | 302 | 82 |
| Protobuf | 108 | 76 |
| FlatBuffers | 164 | 82 |
| Cap'n Proto | 164 | 79 |

Uncompressed, the zero-copy formats are 46 % smaller than JSON and protobuf is 64 % smaller. **After compression all four are within 8 %,** so bandwidth does not decide the format.

### Render path (Node, 1,000-object frames at 10 Hz)

| Scenario | ns / object | Frame p99 | Main thread at 10k/s | Heap allocated / object | GC pauses / s |
|---|---:|---:|---:|---:|---:|
| JSON → objects (today) | 10,891 (10,467–11,314) | 26.8 ms | 10.9 % | 684 B | 0.20 (max 16.4 ms) |
| JSON → positions | 8,362 (7,783–8,941) | 15.4 ms | 8.4 % | 685 B | 0.25 |
| Protobuf → objects | 3,921 | 7.5 ms | 3.9 % | 790 B | 0.23 |
| protobufjs → objects | 4,590 | 8.9 ms | 4.6 % | 1,184 B | 0.15 |
| Protobuf streaming → positions | 1,008 (895–1,121) | 1.6 ms | 1.0 % | 0.7 B | 0.10 |
| **FlatBuffers → positions** | **83** (72–93) | **0.22 ms** | **0.1 %** | **0.6 B** | **0** |
| FlatBuffers flatc-style flyweight → positions | 246 (216–276) | 0.34 ms | 0.2 % | 0.7 B | 0 |
| FlatBuffers official runtime → positions | 672 (612–733) | 1.0 ms | 0.7 % | 0.8 B | 0.05 |
| FlatBuffers WASM → positions (copy-in included) | 114 (103–125) | 0.18 ms | 0.1 % | 0.5 B | 0 |
| **Cap'n Proto → positions** | **53** (32–73) | **0.09 ms** | **0.1 %** | **1.0 B** | **0** |
| Cap'n Proto WASM → positions | 67 (64–69) | 0.12 ms | 0.1 % | 0.5 B | 0 |

Same pattern at the other frame sizes (full tables in the JSON):

| ns / object | 100 / frame | 1,000 / frame | 10,000 / frame |
|---|---:|---:|---:|
| JSON → objects | 7,353 | 10,891 | 7,540 |
| Protobuf streaming | 885 | 1,008 | 1,683 |
| FlatBuffers → positions | 91 | 83 | 101 |
| Cap'n Proto → positions | 69 | 53 | 46 |
| FlatBuffers flatc-style flyweight | 212 | 246 | 206 |
| FlatBuffers official runtime | 628 | 672 | 1,041 |
| FlatBuffers → all scalars + trail (`fields`) | 892 | 690 | 964 |
| Cap'n Proto → all scalars + trail (`fields`) | 602 | 463 | 758 |
| Materialise (FlatBuffers / Cap'n Proto) | 3,560 / 3,226 | 2,887 / 2,537 | 4,563 / 6,811 |

### Frame budget (Node, paced in real time, 60 Hz ticks)

| Scenario | 10 Hz × 1,000: ticks > 4 ms / > 16.7 ms (of ~360) | 1 Hz × 10,000: tick p99 | Access one field of one object (1,000-object frame) |
|---|---:|---:|---:|
| JSON → objects | 60 / 4 | 68 ms | — |
| JSON → positions | 60 / 1 | 161 ms | 6.8 ms (whole parse) |
| Protobuf streaming | 0 / 0 | 24 ms | 3.6 ms (whole decode) |
| FlatBuffers → positions | 0 / 0 | 1.7 ms | **4 µs** |
| Cap'n Proto → positions | 0 / 0 | 1.3 ms | **4 µs** |

### Chrome (decode **and** plot per object; rAF interval jitter in headless Chrome is ~19–22 ms p99 even when idle)

| 1 Hz × 10,000 objects | ns / object | Decode p99 | Dropped frames / 8 s | Frames > 50 ms | Main-thread GC in window |
|---|---:|---:|---:|---:|---:|
| JSON → objects | 7,129 | 91 ms | 33 | 8 | 1 (1.4 ms) |
| Protobuf → objects | 6,697 | 95 ms | 30 | 8 | 3 (15.3 ms) |
| Protobuf streaming | 1,094 | 14 ms | 3 | 0 | 1 |
| FlatBuffers → positions | 122 | 1.9 ms | 3 | 0 | 1 |
| Cap'n Proto → positions | 93 | 1.3 ms | 0 | 0 | 1 |
| FlatBuffers / Cap'n Proto WASM | 199 / 144 | 2.5 / 2.0 ms | 1 / 0 | 0 | 1 |

| CPU throttled 4×, 10 Hz × 1,000 objects | ns / object | Decode p99 | Dropped frames / 8 s | Frames > 50 ms | GC total |
|---|---:|---:|---:|---:|---:|
| JSON → objects | 31,000 | 43 ms | **129** | 12 | 51 ms |
| Protobuf → objects | 35,999 | 70 ms | **155** | 28 | 59 ms |
| Protobuf streaming | 5,792 | 10 ms | 6 | 1 | 17 ms |
| FlatBuffers → positions | 546 | 3.5 ms | 13 | 1 | 26 ms |
| Cap'n Proto → positions | 503 | 1.6 ms | 4 | 1 | 19 ms |
| FlatBuffers / Cap'n Proto WASM | 779 / 639 | 1.8 / 3.3 ms | 3 / 3 | 0 | 12 / 12 ms |

At 4× throttling and 1 Hz × 10,000, JSON's rAF p99 is **374 ms** (165 dropped frames in 8 s); FlatBuffers' is 36 ms and Cap'n Proto's 30 ms.

## Findings

1. **The jank is mostly parse time, not GC pauses.** JSON allocates ~690 B per object (≈ 7 MB/s at 10k objects/s). V8 collects that cheaply: 0.7–2.4 ms of GC per second of stream in Node, and 1–12 short `MinorGC`s (≤ 1.5 ms each) per 8 s window in Chrome. What drops frames is the parse itself: 7–11 µs per object on this laptop, 31–38 µs throttled. That is **7–11 % of the main thread unthrottled and roughly a third of it on a throttled "phone"**, delivered in bursts as big as the frame. At 1 Hz × 10k objects one JSON frame blocks for 70–100 ms (380 ms throttled).
2. **Zero-copy reading removes both costs.** FlatBuffers and Cap'n Proto render-path readers cost 45–100 ns per object (0.1 % of the main thread at the target rate), allocate < 10 B per object, and triggered **almost no GC** in the Node runs (at most one collection in a 20 s run), despite a new ~1.6 MB/s of ArrayBuffers from the network (external memory; V8 frees those backing stores without long pauses). Reading one field of one object in a 1,000-object frame takes 4 µs versus 3.6–6.8 ms for protobuf/JSON, which must decode everything first.
3. **Materialising objects throws the advantage away.** Turning a FlatBuffers or Cap'n Proto frame into plain JS objects costs 2.5–6.8 µs and 770–1,030 B per object, as bad as JSON. The win only exists if map code consumes typed arrays or flyweights. Strings are the expensive part: the render path must not touch `emergency_type` or `responder`.
4. **FlatBuffers and Cap'n Proto are equivalent on speed here.** Cap'n Proto's fixed offsets are 1.3–2× faster than FlatBuffers' vtables (53 vs 83 ns), but both are ~0.1 % of the main thread, below the noise of this machine. Sizes are identical (164 B, 79–82 B deflated).
5. **Protobuf is a good wire format but not a zero-copy one.** A streaming decoder that writes positions without objects is 4.5–11× faster than JSON (0.9–1.7 µs per object), but 10–36× slower than the zero-copy readers, because every field must be scanned to find the next. Its object decoders (hand-written and protobufjs) allocate more than JSON. It also cannot detect truncation at a field boundary: a cut frame is a valid shorter frame, so the transport must carry the length.
6. **Which runtime reads the buffer matters as much as the format.** The official `flatbuffers` runtime with `flatc --ts` code is 7–10× slower than the hand-written render-path reader (628–1,041 vs 83–101 ns). Two causes: resolving the vtable on every field access costs 2–3× (the flatc-style flyweight row: 206–246 ns), and the runtime's `ByteBuffer` costs another ~3×. It still allocates nothing and stays under 1 % of the main thread, so it is fine outside the render path.
7. **WASM does not pay for itself.** The Rust reader has to copy each frame into linear memory first (a network ArrayBuffer cannot be adopted by WASM memory), which makes it 1.2–1.9× slower than the JS reader for FlatBuffers and 1.1–2.7× slower for Cap'n Proto (the gap grows with frame size, since the copy grows while the JS loop stays cheap). JIT-compiled `DataView` reads are already close to native. WASM would only help for work far heavier than reading fields.
8. **Correctness and hardening.** Every reader bounds-checks: the JS readers throw `RangeError` on truncated or corrupt offsets (DataView), the WASM reader returns an error code, and neither reads outside the frame. Neither implements a full FlatBuffers verifier or a Cap'n Proto traversal limit; see the ADR's risks.

## Limitations

- **No phone was measured.** DevTools CPU throttling scales CPU time but not memory bandwidth, GC heuristics or thermal limits. Run `/lab/telemetry-bench` on a mid-range Android device before accepting the ADR.
- **Noisy machine.** Background load (browser, IDE, another agent) and tight memory widened spreads, especially at 10,000-object frames (up to 1.8× between repeats) and in single-repeat Chrome runs. One Node paced run (`protobufjs/positions` @10,000) had a 43 s stall from swapping; it is excluded from conclusions. The ordering of formats was consistent in every repeat.
- **Headless Chrome's rAF jitter** (~19–22 ms p99 at idle) sets a floor of a few "dropped" frames per run for every scenario; compare scenarios against each other, not against zero.
- **Synthetic data** (Lagos-centred random walk). Real telemetry has more repetition, which favours protobuf varints and compression slightly.
- The browser GC figures cover only the 8 s measurement window; a major GC from warm-up garbage can land inside it for any scenario (the single 4–28 ms GC seen in zero-copy rows).
