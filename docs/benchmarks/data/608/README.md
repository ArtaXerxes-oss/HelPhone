# Re-running the #608 benchmark on Android / Safari

ADR-008 is still **Proposed** until follow-up 1 is complete: only one GPU
(Intel Gen7 / Linux) has been measured. No results are recorded in this
directory for Android or Safari yet — this file is the collection procedure,
not evidence.

## Harness

`/lab/cluster-bench` runs the in-app harness. Useful query parameters:

```
?backend=webgpu|webgl2|worker|cpu
&points=50000|100000|250000
&mode=clusters|raw
&autorun=1
```

Each run writes the full result object to `window.__clusterBench` and renders
it on screen. The object includes `frame`, `clusterUpdatesPerSec`,
`hostToGpuUploadMs` / `uploadMeasurement`, `verification`, `conformance`,
`fallbackReasons` and `gpuMemoryBytes`.

With the run paused, collect it from the browser console or a CDP script:

```js
JSON.stringify(window.__clusterBench, null, 2)
```

## Devices to record

| Device | Browser | File to add |
|---|---|---|
| Mid-range Android (e.g. Pixel 6a / Snapdragon 7-series) | Chrome Android with WebGPU | `browser-50k-android-chrome.json`, `browser-100k-android-chrome.json` |
| macOS / iOS Safari with WebGPU enabled | Safari 26+ | `browser-50k-safari.json`, `browser-100k-safari.json` |

## Acceptance checks per device

1. 50k points, `mode=clusters`, 10 s run: `frame.fps >= 60` and
   `frame.droppedPct < 1`.
2. `conformance.pass === true` (all backends vs `binPoints()`, tolerance in
   `src/lib/spatialCluster/fixtures.js`).
3. `fallbackReasons` explains any backend downgrade.
4. 250k run: `clusterUpdatesPerSec >= 60` with two staging buffers; record
   `uploadMeasurement.hostToGpuMs.p50` from the paused-render measurement.
5. WebGL2 opt-in run: `timings.blockingReadbackMs.p50 < 1` ms.

Attach the files to ADR-008 and change its status from *Proposed* to *Accepted*
only after all of the above pass on both device classes.
