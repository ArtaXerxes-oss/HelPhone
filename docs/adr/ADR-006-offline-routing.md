# ADR-006: Offline Client-Side Routing Algorithm & Vector Data Format Selection

- **Status:** Proposed (spike #606 complete)
- **Date:** 2026-09-23
- **Evidence:** [Spike report](../spikes/606-routing-benchmark-report.md) · [raw results](../spikes/results/routing-benchmark.json) · `scripts/spikes/routing_benchmark.js`
**Evidence check:** `routing-benchmark.json#/algorithms/astar/latencyMs/p95 = 19.004`
- **Prototype:** `src/utils/graphTraversal.js`, `src/workers/routingWorker.js`

## Context

When routing servers are unreachable during a disaster, HelPhone has to compute evacuation routes in the browser from a local road graph. The spike measured three things on a 100k-intersection network: memory, query latency, and whether pathfinding can stay off the UI thread.

The test network was a synthetic road grid of **100,485 nodes and 349,977 directed edges**, built from a **58 MB GeoJSON** file. It included one-way streets, dropped segments and shape points. Measurements came from a 2014 dual-core laptop CPU (i5-4300U).

## Decision drivers

1. p95 route latency should stay well under 100 ms on low-end phones.
2. Routing must never drop UI frames. The 60 FPS budget is 16.7 ms per frame.
3. Memory must fit inside a mobile tab alongside Mapbox.
4. Map data must work offline with no server-side step at query time.

## Options considered

| Option | p50 / p95 query | Nodes expanded | Preprocessing | Extra data |
|---|---|---|---|---|
| Dijkstra | 12.0 / 24.7 ms | 47,412 | none | none |
| **A\* (Euclidean heuristic)** | **3.7 / 19.0 ms** | **12,581** | **none** | **none** |
| Contraction Hierarchies (CH) | 4.1 / 7.9 ms | 1,907 | **784 s** | +26.5 MB (1.94 M shortcuts) |

Across all 200 query pairs, the three algorithms returned identical distances.

Data format options:

| Format | Size | Load cost |
|---|---|---|
| GeoJSON parsed on the main thread | 58 MB text, 108 MB heap | `JSON.parse` 0.9 s, graph build 2.5 s, GC pauses up to **322 ms** |
| **Packed CSR typed arrays (one buffer)** | **7.5 MB** | zero-copy view; hand-off to a worker in 1.3 ms (transfer) or 0.85 ms (SharedArrayBuffer) |
| FlatBuffers | similar to CSR | same zero-copy property, adds a dependency and schema tooling |

## Decision

1. **Use A\* with a straight-line heuristic** as the offline routing algorithm. Node coordinates are projected to local metres, and edge weights are polyline lengths in that same plane, so the heuristic is exactly admissible and consistent.
2. **Run all routing in a dedicated `routingWorker`.** Inline A\* raised main-thread event-loop delay to a p99 of 30.6 ms and delivered 50 of 70 frames. In the worker, the p99 was 2.0 ms and every frame was delivered. Worker messaging adds about 0.2 ms per query.
3. **Ship road data as a prebuilt packed CSR binary**, one versioned buffer with the `HPGR` header. Don't ship GeoJSON to the client for routing. Hand the buffer to the worker by transfer, or share it through `SharedArrayBuffer` when the page is cross-origin isolated.
4. **Don't build Contraction Hierarchies on the device.** Preprocessing took 13 minutes, ran 39,625 GCs and added 26.5 MB. If CH is ever needed for much larger regions, precompute it server-side per region and ship it as a second buffer (`HPCH`). The prototype already loads that format.
5. Keep the dependency-free typed-array layout over FlatBuffers for now. It gives the same zero-copy behaviour. Revisit if the schema needs to evolve independently of the app.

## Consequences

- **Positive:** A\* expands about 3.8× fewer nodes than Dijkstra with no preprocessing and no extra data. Queries allocate almost nothing (typed-array scratch space with generation stamps), so only 17 minor GCs totalling 6.5 ms occurred over 200 queries. The graph takes 7.5 MB instead of 108 MB of parsed GeoJSON.
- **Negative:** A\* tail latency (p95 19 ms, max 31 ms on the test laptop) grows with route length. A budget phone could be around 4× slower (an assumption, not measured), so about 80 ms at p95. That is acceptable for route requests but not for per-frame work.
- **Follow-up work:**
  - A build step that converts OSM/GeoJSON extracts to `HPGR` tiles.
  - Wiring the worker into the Help map page. The issue names `src/App.jsx`, but the landing page is now `src/App.tsx` and routing belongs on `/help`, so this spike does not touch app UI.
  - Time-based weights (speed limits, closed roads) with the heuristic scaled by the maximum speed.
- **Risk:** The grid is a pessimistic case for CH, because real road networks have hierarchy and produce far fewer shortcuts. The CH preprocessing cost here is an upper bound. The on-device conclusion still holds.

## Follow-up: HPGR tiles, time weights and the /help worker (#893)

- **Evidence:** [time-weighted](../spikes/results/offline-routing-893.json) and [distance-weighted](../spikes/results/offline-routing-893-distance.json) runs of `node --expose-gc scripts/benchmarks/offline_routing_benchmark.js` (317×317 spike network with road classes, speed limits and 2 % closed roads; 200 random pairs through the routing worker in a `worker_threads` Worker; Node 22, i7-10610U).
- **Evidence check:** `offline-routing-893.json#/queries/workerQueryMs/p95 = 25.106`
- **Evidence check:** `offline-routing-893-distance.json#/queries/workerQueryMs/p95 = 17.428`
- **Code:** `src/lib/routingTiles.js` + `scripts/build-routing-tiles.js` (converter), `src/lib/offlineBundle.js` (versioning, SHA-256), `src/lib/offlineRouting.js` + `src/features/help/OfflineRoutePanel.jsx` (worker on `/help`), `.github/workflows/routing-tiles.yml` (reproducibility).

| 100,473 nodes, 343,074 edges | Distance weights | Time weights |
|---|---|---|
| Tile size | 7.38 MiB | **7.38 MiB** (weights stay one Float64 per edge) |
| Build, reproducible | 3.1 s, yes | 3.2 s, yes (two builds from shuffled input, same SHA-256) |
| Nodes expanded per query | 15,364 | 27,590 |
| Worker query p50 / p95 / max | 3.5 / 17.4 / 31.6 ms | 7.9 / **25.1** / 30.5 ms |

- **Converter.** OSM-tagged road GeoJSON goes in, for example from `osmium export`. Speeds come from `maxspeed` (km/h, mph, or the lowest of a list) or a conservative per-`highway` default. `closed=yes`, `access=no|private` and `highway=construction` roads are left out. Shelters, hospitals, fire stations, police and assembly points become named destinations. Input is reduced to the tags routing uses and sorted first, so feature order, key order and unrelated tags do not change the tile.
- **Header.** Header words 4..7 were reserved and zero, so they now carry the weighting code and the graph's max speed (float64). No format bump was needed: older buffers read as distance-weighted.
- **Scaled heuristic.** For time weights, h = straight-line metres / max speed in the graph. This is admissible and consistent, and a 300-pair test checks A* against Dijkstra.
- **Integrity.** The manifest lists the tile's SHA-256, size, node/edge counts and weighting. The client verifies all of them before the tile reaches the worker. A newer release that fails verification is ignored and the last verified tile stays in use. Only a manifest whose tile verified is cached.
- **`Math.hypot` → `Math.sqrt`** in the heuristic, which is the same value and faster in V8. This brought distance-weighted p95 back to the spike's level.

**Budget: not met for time weights.** The scaled heuristic is weaker: most roads run at 25 km/h but it must divide by the fastest (60 km/h), so A* expands 1.8× more nodes. Distance-weighted p95 here (17.4 ms) matches the spike's 19.0 ms, so this machine runs at about the spike laptop's speed. With the ADR's assumed 4× budget-phone slowdown, time-weighted p95 extrapolates to about **100–110 ms**, at or over the "well under 100 ms" driver; distance-weighted stays at about 70–80 ms. Exactness was kept rather than trading it for speed. Next options, in order:
- **ALT landmarks:** about 1.6–3.2 MB per zone for directed roads.
- **Server-precomputed CH (`HPCH`):** only for the largest zones.

**Not done:** an on-device measurement, and a browser E2E with the network disabled. The offline E2E runs the real worker protocol in Node with fetch failing and tiles served from the Cache API.
