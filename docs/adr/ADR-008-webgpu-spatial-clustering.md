# ADR-008: WebGPU-accelerated spatial clustering for high-density emergency maps

| | |
|---|---|
| Status | Proposed (feasibility spike [#608](https://github.com/Hel-Phone/HelPhone/issues/608)) |
| Date | 2026-09-23 |
| Evidence | [Frame-rate stability and GPU memory benchmark report](../benchmarks/webgpu-spatial-clustering-report.md) · raw data in [`docs/benchmarks/data/608/`](../benchmarks/data/608/) |
| Prototype | `src/shaders/clusterShader.wgsl`, `src/lib/spatialCluster/`, `src/workers/clusterWorker.js`, `src/components/WebGPUMap.jsx` (route `/lab/cluster-bench`) |

## Context

The live map has to show up to 50,000 SOS calls and responders during a large incident, with positions changing continuously. The approach considered so far was a JS spatial index (K-D tree or RBush) rebuilt on every update. That lags under dynamic updates because rebuilding is O(n log n) with poor cache behaviour.

The spike had three questions to answer:

1. Can a WGSL compute shader do the point-distance and grid-bucketing work for 50k points fast enough to keep 60 FPS?
2. How much does it cost to move data between host memory and GPU buffers, compared with rendering in Canvas 2D JS?
3. What fallback do browsers without WebGPU get?

## Decision

**Adopt grid-DBSCAN clustering with a tiered backend. Use a WebGPU compute shader where the browser provides it; otherwise run the same algorithm on the CPU in a Web Worker; use the main thread only as a last resort. Always render clusters, never raw points.**

1. **Algorithm: grid-DBSCAN instead of a tree index.** Points are bucketed into a uniform grid (24 px cells at the current map scale). Each cell accumulates a count, a fixed-point centroid sum and a max distance to its centroid. Dense cells are merged over their 8 neighbours with union-find on the CPU. Bucketing is O(n) and trivially parallel, and the merge is O(occupied cells). At 50k points that means 1,104 cells instead of 50,000 points to merge.
2. **Core-cell threshold: `max(minPts, 2 × mean count of occupied cells)`.** A fixed `minPts` merges the whole map into one cluster at 50k points, because the uniform background already exceeds it (report, finding 1).
3. **Default backend chain: WebGPU → Worker → main thread.** Selection is automatic and every fallback reason is recorded (`createClusterer()` in `src/lib/spatialCluster/index.js`).
4. **WebGL2 is opt-in only — keep the path, with asynchronous readback.** The original prototype's synchronous `readPixels` blocked the main thread for 3.6–9.8 ms on hardware and 51 ms on software GPUs. It now reads through two pixel-pack buffers guarded by `fenceSync` (`createAsyncReadback()` in `webgl2Clusterer.js`); `clientWaitSync(..., 0)` polls without blocking and yields between checks. **Decision: keep WebGL2 as an opt-in third backend (`preferred: "webgl2"`), not in the default chain.** The blocking readback is gone, but context setup and the two rasterisation passes are still slower than the Worker path, so promoting it would be a regression. Revisit only if a device shows it beating the Worker.
5. **One CPU reference.** `binPoints()` defines the expected output. The WGSL shader and GLSL path mirror its bucketing and fixed-point quantisation, and the benchmark checks each backend against it before measuring.

## Rationale (measured on Intel HD 4400 / Chrome 147; full tables in the report)

| At 50k points | WebGPU | Worker | Main thread | Raw Canvas 2D |
|---|---:|---:|---:|---:|
| FPS / dropped frames | 60.0 / 0.0% | 60.0 / 0.0% | 60.0 / 0.0% | 17.8 / 98.9% |
| Grid-stage compute p50 | **0.85 ms** (GPU pass) | 8.4 ms | 6.9 ms | — |
| Main-thread cost per update p50 | **0.74 ms** | 0.30 ms | 7.21 ms | 19.3 ms (draw) |
| End-to-end cluster latency p50 | 7.8 ms | 9.2 ms | 6.9 ms | — |

| Scaling | 100k points | 250k points |
|---|---|---|
| WebGPU GPU pass p50 | 1.41 ms | 3.70 ms |
| Main-thread JS compute p50 | 30.8 ms (22.5 FPS) | 45.7 ms (17.4 FPS) |
| Worker cluster updates/s | 12.6 | 13.6 (FPS stays 59.6) |

- **Rendering is the main bottleneck, not clustering.** Drawing 50k raw points costs 19 ms per frame, so clustering is required with any backend.
- **At the 50k target, WebGPU does not decide whether we reach 60 FPS.** A grid in a Worker already does. WebGPU buys headroom: an 8–22× faster grid stage, main-thread cost below 1.3 ms up to 250k points, and full-rate updates at 100k, where the Worker falls to 13 updates per second.
- **Host↔GPU transfer is not the cost.** Uploading 50k points (400 KB) takes 0.59 ms p50, and only about 17 KiB of cell data comes back. The `mapAsync` round-trip (~7.5 ms of queue latency) sets WebGPU's latency, so results are about one frame behind. A live incident map can accept that.
- **Correctness.** Every backend matched the CPU reference. WebGPU differed in ≤ 2 of 1,104 cells, where f32 and f64 `floor()` disagree on boundary points. Centroid error was ≤ 0.021 px across all backends.
- **GPU memory is small and predictable.** It works out to 12 B × point capacity plus 32 B × cells: 621 KiB at 50k points and 3.0 MiB at 250k.

## Alternatives considered

| Option | Outcome |
|---|---|
| JS K-D tree / RBush rebuilt every frame | Rejected. This is the status quo the issue describes. The rebuild is O(n log n) and cannot run on a GPU. A uniform grid is a better fit for a bounded viewport. |
| Full DBSCAN (point-level ε-neighbourhoods) on GPU | Rejected for now. It needs sorted cells and neighbour scans per point, with far more complexity and memory traffic. Grid-DBSCAN gives the same visual result at map zoom levels. |
| WebGL2 transform feedback / float-blend scatter as the default fallback | Deferred. It works, but its readback blocks (see Decision 4). |
| Worker only, no WebGPU | Viable at ≤ 50k points. Rejected as the only path because update rate drops below 15 per second from 100k points and CPU throttling hits phones hardest. |
| Render clusters with WebGPU too | Out of scope. Canvas 2D draws the clustered output in about 1 ms, and Mapbox GL owns rendering on `/help`. |

## Consequences

**Positive**

- The map stays at 60 FPS at 50k points on every backend tested, including software GPUs, because rendering always sees clusters.
- With WebGPU the main-thread budget per update stays below 1.3 ms up to 250k points.
- The cluster output format is identical across backends, so the map UI does not need to know which backend ran.

**Negative / risks**

- Only one GPU (Intel Gen7, Linux) was benchmarked. Mobile GPUs and Safari are unmeasured, and must be measured before this moves from Proposed to Accepted.
- Cluster results arrive about one frame late on WebGPU. Anything that must be pixel-exact against the current frame (for example hit-testing a single SOS marker) should use CPU data.
- Fixed-point u32 sums limit capacity: `maxPoints × cellSize × fixedScale ≤ 2³²`. `createGridParams()` enforces this and lowers precision automatically, which allows about 179M points at 24 px cells.
- Two shader languages (WGSL and GLSL) have to stay in sync with the JS reference. The WGSL contract (workgroup size, sentinel, bindings, `Params` layout) is pinned by unit tests. The GLSL path is covered only by the browser benchmark's check against the CPU reference.

## Browser support and fallback

| Browser | Clustering path |
|---|---|
| Browsers exposing `navigator.gpu` with an adapter (Chromium desktop and Android; recent Safari and Firefox releases) | WebGPU |
| Everything else with Web Workers | Worker (CPU grid) |
| No Worker support (very old WebViews) | Main thread |

WebGPU availability changes with each browser release. The code detects support at runtime (`navigator.gpu.requestAdapter()`) and does not sniff user agents, so the table needs no maintenance for correctness. It should be checked against current vendor release notes when this ADR is accepted.

## Follow-up work (not in this spike)

1. **OPEN.** Run the benchmark harness on a mid-range Android phone and on Safari with WebGPU, and attach the results to this ADR. See [`docs/benchmarks/data/608/README.md`](../benchmarks/data/608/README.md); no device results are fabricated here.
2. **DONE.** Double-buffered (ping-pong) staging buffers in `webgpuClusterer.js` (`STAGING_BUFFER_COUNT = 2`); a frame can be submitted while the previous result is being mapped/read. `clusterUpdatesPerSec` is recorded by the harness.
3. **DONE (harness).** `WebGPUMap.runBenchmark()` now pauses both clustering and drawing while it collects 30 `measureUpload()` samples at 250k, and records them as `uploadMeasurement` / `hostToGpuUploadMs`. Re-run on target hardware to replace the earlier contended 48.7 ms figure.
4. **DONE.** `useClusteredMap()` + `ClusteredMapLayer` project lat/lng to the viewport pixel grid at each zoom (`viewportGrid.js`) and render clusters only. Wired into `CommunityMap` and `/help` behind the `canary_map_clustering` flag. Backend and fallback reasons are recorded in `clusterTelemetry`. Single-marker hit-testing uses CPU point data.
5. **DONE — keep.** Asynchronous PBO + `fenceSync` readback implemented; decision recorded in Decision 4 above. WGSL, GLSL and the JS reference are pinned to shared fixtures (`fixtures.js`, `conformance.js`).

## Production wiring (2026-11-24)

- `src/lib/spatialCluster/viewportGrid.js` is the single projection boundary:
  Web Mercator at tile size 512, grid origin = centre world pixel minus half
  the viewport. Pan/zoom mutates the params origin in place so the WebGPU
  device and Worker survive camera moves.
- `src/hooks/useClusteredMap.js` owns backend selection, one-in-flight update
  queueing and merge; `src/components/ClusteredMapLayer.jsx` draws only
  clusters. A click resolves via `hitTestSingleMarker()` against raw CPU data.
- `src/lib/clusterTelemetry.js` records `cluster.backend.selected` with the
  full fallback-reason list. It is exposed as `window.__helphoneClusterTelemetry`
  and as a `helphone:cluster-telemetry` DOM event, so a fallback reason is
  observable without a debugger.
- Shared fixtures define the tolerance: at most 2 count-mismatch cells (f32 vs
  f64 boundary `floor()`), ≤ 0.05 px centroid error and ≤ 0.05 px radius error.
