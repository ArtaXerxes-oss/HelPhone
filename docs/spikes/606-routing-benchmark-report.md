# Spike #606: Pathfinding Benchmark & Worker Overhead Report

Feeds [ADR-006](../adr/ADR-006-offline-routing.md). Raw numbers: [`results/routing-benchmark.json`](results/routing-benchmark.json).

## What was built

| File | Purpose |
|---|---|
| `src/utils/graphTraversal.js` | GeoJSON → CSR graph builder, packed zero-copy buffer format (`HPGR` graph, `HPCH` hierarchy), indexed binary heap, Dijkstra, A\*, Contraction Hierarchies (preprocessing, bidirectional query, shortcut unpacking), synthetic road-network generator |
| `src/workers/routingWorker.js` | Worker protocol (`load`, `loadGeoJSON`, `buildCH`, `route`, `ping`) around a pure `handleRoutingMessage()` so it runs under Node `worker_threads` and in unit tests |
| `scripts/spikes/routing_benchmark.js` | This benchmark |
| `test/graph-traversal.test.js` | 14 tests. Dijkstra, A\* and CH are cross-checked on random one-way networks: equal distances, and every path is a real edge chain. |

## Method

- **Network:** `generateRoadNetworkGeoJSON({ rows: 317, cols: 317 })`, a jittered street grid around Lagos. About 8 % of segments are removed, 10 % are one-way, and each segment has 3 shape points. The result is **58.07 MB of GeoJSON, 184,326 LineStrings, 100,485 intersections and 349,977 directed edges.** Only intersections become nodes. Shape points add length but no nodes.
- **Queries:** 200 random reachable node pairs, identical for every algorithm, after 10 warm-up queries.
- **Machine:** Intel i5-4300U (2 cores / 4 threads, 1.9 GHz, 2014), Node 22.22, `--expose-gc`. GC pauses come from `PerformanceObserver('gc')`, excluding collections forced for heap sampling.
- **Worker test:** the same 200 A\* queries run (a) inline, yielding with `setImmediate` between queries, and (b) through a `worker_threads` worker running `routingWorker`'s handler. Main-thread responsiveness is measured with `monitorEventLoopDelay` and a 60 Hz ticker that counts delivered "frames".

Reproduce:

```bash
node --expose-gc --max-old-space-size=3072 scripts/spikes/routing_benchmark.js \
  --rows 317 --queries 200 --out docs/spikes/results/routing-benchmark.json
# --skip-ch skips the ~13 min CH preprocessing
```

## Results

### Loading the 50 MB-class dataset

| Step | Time | Memory |
|---|---|---|
| `JSON.parse` (58 MB) | 922 ms | 108.3 MB heap for the parsed object |
| Build CSR graph | 2,541 ms | — |
| Packed graph buffer | — | **7.46 MB** (one ArrayBuffer) |
| GC during load | 47 collections, 760 ms total, **max pause 322 ms** | — |

A 322 ms pause is about 19 dropped frames. GeoJSON must never be parsed on the UI thread, and ideally not on the device at all: shipping the packed buffer skips both the parse and the build.

### Query latency (200 queries, ms)

| Algorithm | mean | p50 | p95 | max | avg nodes expanded | avg edges relaxed | GC during queries |
|---|---|---|---|---|---|---|---|
| Dijkstra | 12.3 | 12.0 | 24.7 | 39.2 | 47,412 | 54,616 | none |
| A\* (Euclidean) | 5.5 | 3.7 | 19.0 | 30.8 | 12,581 | 17,665 | 17 minor, 6.5 ms total, max 0.85 ms |
| CH (bidirectional) | 4.1 | 4.1 | 7.9 | 13.3 | 1,907 | 9,323 | 1, 4.9 ms |

All three algorithms returned identical distances on all 200 queries (`correctness` in the JSON).

### Contraction Hierarchy preprocessing

| Metric | Value |
|---|---|
| Wall time | **784 s** (13.1 min) |
| Shortcuts added | 1,944,786 (19 per node) |
| Packed CH size | 26.5 MB |
| GC during preprocessing | 39,625 collections, 25.4 s total, max 87.6 ms |

Ordering uses lazy priority updates. Recomputing neighbour priorities after every contraction was 4–7× slower in pilot runs. A jittered grid has no road hierarchy, so the contraction core grows dense. Real OSM networks produce far fewer shortcuts, which makes these figures an upper bound. Even at a tenth of this cost, building CH on a phone is not viable.

### Worker off-loading

| Measure | Inline (UI thread) | Routing worker |
|---|---|---|
| Event-loop delay p99 / max | 30.6 / 37.1 ms | **2.0 / 4.3 ms** |
| 60 Hz frames delivered | 50 of 70 expected | 77 of 74 expected |
| A\* round trip p50 / p95 | — | 3.9 / 21.4 ms |
| Messaging overhead (round trip − compute) p50 / p95 | — | **0.20 / 0.36 ms** |
| CH round trip p50 / p95 | — | 5.2 / 9.8 ms |

Graph hand-off to a fresh worker (7.46 MB, including the worker's unpack):

| Method | Time |
|---|---|
| structured clone (copy) | 10.7 ms |
| transfer (`postMessage(msg, [buffer])`) | 1.3 ms |
| `SharedArrayBuffer` | 0.85 ms |

Transfer is nearly as cheap as `SharedArrayBuffer`, and it doesn't need cross-origin isolation (COOP/COEP), which the app doesn't currently set. Use transfer by default and SAB when isolated. A shared buffer also lets several workers route over one copy of the graph.

## Findings

1. **A\* in a worker is the right default.** It needs no preprocessing, expands 3.8× fewer nodes than Dijkstra, has a p95 under 20 ms on this laptop, and adds 0.2 ms of worker overhead. The UI thread stays at a 2 ms p99 event-loop delay.
2. **The format matters more than the algorithm for memory.** The packed CSR graph is 14.5× smaller than the parsed GeoJSON, and loading it causes no GC pauses.
3. **CH is a server-side optimisation, if it's needed at all.** It gives the best tail latency (p95 7.9 ms), but preprocessing costs minutes of CPU and 26.5 MB of extra download.
4. **Mobile figures are extrapolated.** No phone was measured. Treat a 3–5× slowdown as the working assumption for budget Android devices (about 60–100 ms A\* p95) until the benchmark is run on real devices.

## Limitations

- Distance-only weights. Time-based routing needs the heuristic divided by the maximum speed to stay admissible.
- The synthetic grid is not a real road network. Rerun on an OSM extract (for example Lagos) converted with `buildGraphFromGeoJSON`.
- Worker results come from Node `worker_threads`. Browser workers have a similar messaging cost profile, but this spike didn't measure them.
