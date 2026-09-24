# ADR-002: WASM Memory Isolation Strategy for Client-Side Encrypted Payloads

- **Status:** Proposed
- **Date:** 2026-09-23
- **Spike:** #602 (time box 2 days)
- **Prototype:**
  - `src/wasm/memory_sandbox.rs` (compiled to `src/wasm/memory_sandbox.wasm`, 574 bytes)
  - `src/utils/wasmLoader.js`
  - `scripts/spikes/wasm_memory_bench.js`
  - `test/wasm-loader.test.js`

## Context

Two kinds of sensitive data are processed client-side:

- encrypted audio streams from people requesting help
- ZK witnesses and responder proofs

If both share one heap, a bug in one path (for example an out-of-bounds read in audio DSP) can expose the other path's secrets. We asked three questions:

1. Can the WebAssembly multi-memory proposal give each domain a strictly separate linear memory?
2. Can data move between those memories without heavy copy overhead?
3. What happens on engines without multi-memory?

## What was built

- **`memory_sandbox.rs`:** a `no_std` Rust module compiled with plain `rustc`. It has one linear memory, a bump allocator, volatile `sandbox_wipe`, `sandbox_reset` (which wipes, then frees), an FNV-1a checksum and a PCM gain kernel standing in for audio DSP.
  - It uses raw exports instead of `wasm-bindgen`. wasm-bindgen generates JS glue that assumes one memory, has no way to emit multi-memory, and would add about 10 KB of glue to a 574-byte module.
- **`wasmLoader.js`:**
  - Creates one sandbox instance for **audio** and one for **ZK**. Each instance can only address its own memory.
  - Feature-detects multi-memory with `WebAssembly.validate` on a two-memory probe module.
  - When multi-memory is present, it assembles a roughly 70-byte **bridge** module at runtime. The bridge imports both memories and runs `memory.copy` between them.
  - Otherwise it falls back to `Uint8Array.set`.

## Finding 1: multi-memory does not add isolation

Isolation comes from **separate instances**, not from multi-memory:

- Each sandbox exports only its own memory and imports nothing, so no sandbox code can reach the other domain.
- Only the loader holds references to both memories, whether through the bridge or through JS views.

Multi-memory changes only _how_ the host copies between the two memories. It is a performance feature here. It is also the only way to _weaken_ isolation, because a module that imports both memories can read both.

The bridge is safe because it is ~70 bytes assembled in the loader and exports nothing but two fixed-direction copy functions.

## Finding 2: the transfer cost is small, and multi-memory helps only modestly

`node scripts/spikes/wasm_memory_bench.js --runs 300` on Node 22.22.2 / V8 12.4, Intel i5-4300U. Every transfer is verified byte-exact by checksum on the first run.

| Strategy                                                       | 10 MB median | 10 MB p95 | 10 MB throughput | 1 MB median |
| -------------------------------------------------------------- | -----------: | --------: | ---------------: | ----------: |
| Pointer pass in one shared memory (**no isolation**, baseline) |        ~0 ms |     ~0 ms |              n/a |       ~0 ms |
| Multi-memory `memory.copy` bridge                              |      1.57 ms |   2.66 ms |         6.7 GB/s |     0.17 ms |
| JS `Uint8Array.set` between memories (fallback)                |      1.86 ms |   2.16 ms |         5.6 GB/s |     0.26 ms |
| Slice out, then write in (holding one sandbox at a time)       |      10.3 ms |   24.1 ms |         1.0 GB/s |     1.03 ms |
| `structuredClone` (postMessage to a Worker without transfer)   |       4.1 ms |   14.6 ms |         2.5 GB/s |     0.31 ms |

Reading the table:

- Both direct paths are memcpy-bound: under 2 ms for 10 MB, which is minutes of Opus audio. Multi-memory is 15–35% faster across runs, but single runs are noisy enough to overlap.
- The expensive pattern is **copying out to a detached JS buffer and back in**. It costs 5–6× more and puts a plaintext copy on the JS heap, where it cannot be wiped deterministically. That defeats the purpose.
- Zero-copy (one shared memory) is the only faster option, and it is exactly the loss of isolation we are trying to avoid.

## Finding 3: engine support, and the fallback

| Engine                                    | Multi-memory                                        | How established                                                                                  |
| ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| V8 (Chrome/Edge, Node 22)                 | Supported                                           | **Verified** in this spike: `detectFeatures()` returns `multiMemory: true`; bridge tests pass    |
| SpiderMonkey (Firefox)                    | Expected to be supported (shipped in 2024 releases) | **Not verified here.** Confirm by running `detectFeatures()` in the browser console              |
| JavaScriptCore (Safari, all iOS browsers) | Not assumed                                         | **Not verified here.** Every iOS browser uses JSC, so the fallback path must be production-grade |

The fallback is not a degraded mode. It gives the same isolation at about 1.2× the copy time (0.3 ms extra per 10 MB), so mobile browsers without multi-memory lose nothing that matters. `test/wasm-loader.test.js` exercises the fallback by simulating an engine that rejects multi-memory. It also covers transfers that grow the destination memory mid-copy, which detaches old `ArrayBuffer` views. The loader re-reads `.buffer` after allocating for this reason.

## Decision

1. **Isolate by instance:** one `memory_sandbox` instance per trust domain (audio, ZK). Never share a linear memory across domains.
2. **Transfer through `wasmLoader.transfer()` only.** Use the multi-memory bridge when `detectFeatures().multiMemory` is true, and `Uint8Array.set` otherwise. Do not require multi-memory.
3. **Ban the slice-out/write-in pattern** for sensitive payloads. It is slower, and it leaves unwipeable plaintext on the JS heap.
4. **Wipe after use:** call `sandbox_reset()` (volatile wipe, then free) on the ZK sandbox after each proof, and on the audio sandbox after each stream segment.
5. **Next step, out of this spike:** instantiate the ZK sandbox inside the existing `src/workers/zk-worker.js`, so ZK memory is also separated from the main thread's JS realm. Moving data across that thread boundary costs one clone. That is 4 ms per 10 MB, or O(1) with a transferable `ArrayBuffer` once the audio side has copied into a buffer it owns. Either is acceptable against proof generation, which takes seconds.

## Consequences

- Rust source for sandboxes is built with `npm run build:wasm-sandbox` (plain `rustc`, no wasm-pack or wasm-bindgen). The 574-byte `.wasm` is committed so the frontend build does not need a Rust toolchain.
- No `vite.config.ts` change is needed. The loader references the module as `new URL("../wasm/memory_sandbox.wasm", import.meta.url)`, which Vite emits as an asset. The existing Workbox `globPatterns` already precaches `*.wasm`.
- `SharedArrayBuffer`-backed memories are deliberately not used. They require cross-origin isolation, and they re-introduce shared state between threads.

## Reproduce

```bash
npm run build:wasm-sandbox
npx vitest run test/wasm-loader.test.js
node scripts/spikes/wasm_memory_bench.js --runs 300          # 10 MB
node scripts/spikes/wasm_memory_bench.js --runs 300 --mb 1
```
