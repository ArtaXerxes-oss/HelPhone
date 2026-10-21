# Frame-rate stability and GPU memory benchmark: spatial clustering

Spike: [#608](https://github.com/Hel-Phone/HelPhone/issues/608) · Decision record: [ADR-008](../adr/ADR-008-webgpu-spatial-clustering.md) · Raw data: [`data/608/`](data/608/)

## Summary

- **Clustering is required, whatever the backend.** Drawing 50,000 raw points with Canvas 2D takes 19.3 ms per frame (17.8 FPS, 98.9% of frames dropped). Clustered, the same scene draws in about 1 ms and every backend holds 60 FPS at 50k.
- **WebGPU is 8–22× faster than JS at the grid stage.** On Intel Gen7 the compute pass takes 0.85 / 1.41 / 3.70 ms at 50k / 100k / 250k points. The main-thread JS path takes 6.9 / 30.8 / 45.7 ms.
- **WebGPU keeps the main thread free.** It spends 0.7–1.2 ms per update on the main thread (encode, readback copy and merge). End-to-end latency is set by the `mapAsync` round-trip (about 7.5 ms), not by compute, so cluster results arrive about one frame late. The live map can tolerate that.
- **A Worker is a sound fallback.** It holds 60 FPS at 50k and 250k and never blocks the main thread. Cluster updates slow to about 13 per second above 100k points. The single 100k run dropped 15% of frames even so, most likely from thermal throttling (see Limitations).
- **WebGL2 works but blocks.** Its results are correct, but the synchronous `readPixels` costs 3.6–9.8 ms of main-thread time on hardware and 51 ms on a software GPU. It is not in the default fallback chain (see ADR-008).
- **All backends agree with the CPU reference.** No cell counts differ, apart from ≤ 2 boundary cells per run on WebGPU (f32 vs f64 `floor`). Centroid error is ≤ 0.021 px.

## What was measured

| Item | Value |
|---|---|
| Workload | `generateIncidents()`: 70% of points in 24 Gaussian hotspots, 30% uniform. Every point moves every frame. Seed 608. |
| Viewport / grid | 1140×540 px (the landing-page map), 24 px cells → 48×23 = 1,104 cells |
| Clustering | Grid-DBSCAN. A core cell holds ≥ max(8, 2 × the mean count of occupied cells); adjacent core cells are merged over 8 neighbours. |
| Run length | 10 s per backend after a 1.5 s warm-up, driven by `scripts/bench/cluster-browser-bench.mjs` |
| Correctness check | Before each run, one snapshot is clustered by the backend under test and by the CPU reference (`binPoints`), then compared cell by cell |
| Hardware | Intel Core i5-4300U (Haswell, 4 threads), Intel HD 4400 iGPU (WebGPU adapter `intel / gen-7`), Linux, Chrome 147 headed |
| Software GPU | Same machine, headless Chrome 147, WebGPU/WebGL on SwiftShader (adapter `google / swiftshader`) |

Column definitions:

- **Cluster latency**: from the start of `cluster()` to the grid being available in JS.
- **GPU pass**: WebGPU `timestamp-query` time for both compute dispatches.
- **Main-thread cost**: the time each update blocks the UI thread. For WebGPU that is encode + readback copy + merge; for WebGL2, the whole call + merge; for the Worker, only the merge; for the main-thread CPU backend, compute + merge.
- **Dropped**: the share of frames longer than 25 ms, meaning at least one vsync was missed.

## Results: hardware GPU (Intel Gen7)

### 50,000 points (the target in #608)

| Backend | FPS | p95 frame | Dropped | Cluster latency p50 / p95 | GPU pass p50 | Main-thread cost p50 | Cluster updates/s | Cells differing from CPU / max centroid err (px) | GPU memory |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| WebGPU | 60.0 | 16.7 ms | 0.0% | 7.77 / 10.64 ms | 0.846 ms | 0.74 ms | 59.4 | 2 / 0.005 | 621 KiB |
| WebGL2 | 60.0 | 16.7 ms | 0.0% | 3.18 / 4.41 ms | — | 3.64 ms | 60.1 | 0 / 0.021 | 425 KiB |
| Worker | 60.0 | 16.7 ms | 0.0% | 9.16 / 12.01 ms | — | 0.30 ms | 59.0 | 0 / 0.000 | — |
| Main thread | 60.0 | 16.7 ms | 0.0% | 6.91 / 8.98 ms | — | 7.21 ms | 60.1 | 0 / 0.000 | — |
| Raw Canvas 2D (no clustering) | 17.8 | 83.4 ms | 98.9% | — | — | 19.26 ms (draw) | — | — | — |

WebGPU host→GPU upload (`writeBuffer` of 400 KB plus `onSubmittedWorkDone`, 30 samples): p50 0.59 ms, p95 6.83 ms. Staging readback copy p50: 0.065 ms. Encode p50: 0.20 ms.

### 100,000 points

| Backend | FPS | p95 frame | Dropped | Cluster latency p50 / p95 | GPU pass p50 | Main-thread cost p50 | Cluster updates/s | Cells differing / max err (px) | GPU memory |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| WebGPU | 59.9 | 16.7 ms | 0.2% | 7.84 / 10.54 ms | 1.407 ms | 0.82 ms | 59.9 | 2 / 0.006 | 1,206 KiB |
| WebGL2 | 51.9 | 33.4 ms | 14.8% | 3.66 / 19.41 ms | — | 4.11 ms | 52.1 | 0 / 0.016 | 816 KiB |
| Worker | 51.6 | 33.3 ms | 15.0% | 67.21 / 97.75 ms | — | 0.58 ms | 12.6 | 0 / 0.000 | — |
| Main thread | 22.5 | 66.7 ms | 94.3% | 30.75 / 55.35 ms | — | 31.33 ms | 22.8 | 0 / 0.000 | — |

### 250,000 points (stress)

| Backend | FPS | p95 frame | Dropped | Cluster latency p50 / p95 | GPU pass p50 | Main-thread cost p50 | Cluster updates/s | Cells differing / max err (px) | GPU memory |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| WebGPU | 54.0 | 33.3 ms | 10.0% | 11.50 / 64.97 ms | 3.702 ms | 1.22 ms | 30.9 | 0 / 0.001 | 2,964 KiB |
| WebGL2 | 56.6 | 33.3 ms | 5.2% | 9.22 / 12.87 ms | — | 9.76 ms | 57.2 | 0 / 0.007 | 1,988 KiB |
| Worker | 59.6 | 16.7 ms | 0.5% | 61.00 / 75.13 ms | — | 0.50 ms | 13.6 | 0 / 0.000 | — |
| Main thread | 17.4 | 83.4 ms | 100.0% | 45.68 / 72.12 ms | — | 46.12 ms | 17.7 | 0 / 0.000 | — |

At 250k points the WebGPU upload probe measured a p50 of 48.7 ms. At 50k and 100k it was under 1 ms. The probe awaits `onSubmittedWorkDone`, so it also waits for the render loop's in-flight dispatch. The number is therefore an upper bound on queue contention, not raw PCIe/UMA bandwidth. This needs a clean re-measurement before any claim is made above 100k points (see follow-ups).

## Results: software GPU (SwiftShader, headless, 50k points)

This profile matches CI and machines where the GPU is blocklisted.

| Backend | FPS | p95 frame | Dropped | Cluster latency p50 / p95 | GPU pass p50 | Main-thread cost p50 | Cluster updates/s |
|---|---:|---:|---:|---:|---:|---:|---:|
| WebGPU | 59.9 | 16.7 ms | 0.2% | 21.70 / 26.47 ms | 15.031 ms | 0.58 ms | 35.7 |
| WebGL2 | 16.7 | 66.7 ms | 100.0% | 51.29 / 57.24 ms | — | 51.56 ms | 16.9 |
| Worker | 59.5 | 16.7 ms | 0.7% | 10.94 / 22.59 ms | — | 0.40 ms | 55.7 |
| Main thread | 60.0 | 16.7 ms | 0.0% | 7.82 / 10.39 ms | — | 8.09 ms | 60.2 |
| Raw Canvas 2D | 19.3 | 66.7 ms | 100.0% | — | — | 44.07 ms (draw) | — |

Even running in software, WebGPU does not block the main thread, because the work is asynchronous and only the update rate falls. Software WebGL2 is the worst option measured, which is why it is not a default fallback.

## Results: CPU grid stage in Node (no browser)

Output of `node scripts/bench/cluster-cpu-bench.mjs --json` ([`data/608/node-cpu.json`](data/608/node-cpu.json)), same CPU, 200 iterations after 30 warm-up. These are the exact `binPoints` and `mergeCells` functions the Worker and main-thread backends run. This run followed the browser benchmarks, with the CPU package at 81 °C.

| Points | binPoints p50 | binPoints p95 | mergeCells p50 | total p95 | Dense clusters |
|---:|---:|---:|---:|---:|---:|
| 5,000 | 0.75 ms | 1.11 ms | 0.37 ms | 1.98 ms | 27 |
| 10,000 | 1.48 ms | 2.18 ms | 0.39 ms | 2.84 ms | 13 |
| 50,000 | 7.45 ms | 10.67 ms | 0.42 ms | 11.25 ms | 5 |
| 100,000 | 15.04 ms | 17.15 ms | 0.40 ms | 17.59 ms | 3 |
| 250,000 | 42.12 ms | 63.65 ms | 0.46 ms | 64.69 ms | 3 |

An earlier run with a cool CPU measured 6.40 ms at 50k and 32.96 ms at 250k (binPoints p50). A heavily throttled run in between reached 23.6 ms at 50k. On a fanless laptop or phone, thermal throttling makes the JS path 1.2–3.7× slower.

`mergeCells` stays at about 0.4 ms at every point count because it is O(occupied cells), not O(points).

## GPU memory allocation

WebGPU memory depends on the point capacity and the number of grid cells, and on nothing else:

| Buffer | Size |
|---|---|
| `points` (vec2<f32>) + `pointCell` (u32) | 12 B × point capacity |
| `cellCount` + `cellSum` (2×u32) + `cellRadius` | 16 B × cells |
| Staging readback (MAP_READ) | 16 B × cells + 16 B timestamps |
| Uniform params | 32 B |

With 1,104 cells, measured totals are 621 KiB at 50k points, 1.2 MiB at 100k and 3.0 MiB at 250k. That is well under the 128 MiB default `maxStorageBufferBindingSize`. Point buffers grow by doubling, so they are not reallocated every frame. Only O(cells) bytes (about 17 KiB) come back to the CPU each update, whatever the point count.

## Findings that affect the design

1. **A fixed DBSCAN `minPts` fails at this density.** With 50k points on a 1140×540 map, the uniform background alone averages about 14 points per 24 px cell. With `minPts = 8`, every cell is a core cell and the whole map merges into **one** cluster. A density-relative threshold (2× the mean of occupied cells) gives 5 hotspot clusters at 50k. Unit tests cover both cases.
2. **`mapAsync` latency is the floor.** WebGPU's end-to-end latency (7.5 ms) is roughly 9× the compute time on this driver. Batching more work into each submit is cheap. Waiting on readback every frame is what costs. Double-buffered staging buffers would allow one update per frame even at 250k.
3. **`centroid` is a reserved word in GLSL ES 3.00.** The first WebGL2 run failed to compile for this reason, and the fallback chain dropped to the Worker as designed. This is fixed; it is noted here because nothing reports it until the code runs on real hardware.
4. **The Worker path pays a copy for every update.** It copies the point buffer so the main thread keeps ownership of the live simulation (400 KB at 50k). For production data coming from the network, the Worker should own the positions and receive deltas instead.

## Limitations

- One device class was tested: a 2013 laptop iGPU (Intel Gen7). Mobile GPUs (Adreno and Mali on Android Chrome, Apple GPUs on Safari) have not been measured. Run the harness on at least one mid-range Android phone before adopting WebGPU in production.
- Each size was run once. Treat p95 values as indicative, especially where thermal throttling showed up (100k Worker, 250k upload).
- The workload is synthetic. The positions of real SOS calls will cluster differently.
- Canvas 2D is the only renderer measured. Drawing the clusters with WebGPU or Mapbox GL layers is out of scope.

## How to reproduce

```bash
npm ci --legacy-peer-deps              # upstream lockfile needs this today
npm run dev                            # then open http://localhost:3000/lab/cluster-bench
node scripts/bench/cluster-cpu-bench.mjs
node scripts/bench/cluster-browser-bench.mjs --points 50000 --headed
# optional: CHROME_PATH=/path/to/chrome  --backends webgpu,worker,cpu,raw
```

The lab page accepts `?backend=webgpu|webgl2|worker|cpu&points=N&mode=clusters|raw&autorun=1`. A run prints its JSON summary on the page and stores it on `window.__clusterBench`.

## Follow-ups

- Re-measure host→GPU upload at 250k with the render loop paused, to separate bandwidth from queue contention.
- Use double-buffered staging (two `MAP_READ` buffers in rotation) so WebGPU updates every frame at ≥ 250k.
- If WebGL2 stays, make its readback asynchronous with a PBO and `fenceSync`.
- Run the harness on Android Chrome (Adreno or Mali) and on Safari with WebGPU.
