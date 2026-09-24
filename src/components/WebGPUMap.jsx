// WebGPU spatial-clustering prototype map + benchmark harness (issue #608).
//
// Renders up to 100k moving SOS / responder points, clustered every frame by
// the best available backend (WebGPU -> Worker -> main thread; WebGL2 is
// opt-in via the backend picker), and
// drawn with Canvas 2D. A "raw" mode draws every point with no clustering as
// the Canvas 2D baseline the spike compares against.
//
// Mounted at /lab/cluster-bench. Query params (for scripted runs):
//   ?backend=webgpu|webgl2|worker|cpu  ?points=50000  ?mode=clusters|raw
//   ?autorun=1  -> runs the benchmark once, result on window.__clusterBench
// See docs/adr/ADR-008-webgpu-spatial-clustering.md.

import { useCallback, useEffect, useRef, useState } from "react";
import { BACKEND_ORDER, binPoints, createClusterer, createGridParams, mergeCells } from "../lib/spatialCluster/index.js";
import { generateIncidents, stepIncidents } from "../lib/spatialCluster/syntheticIncidents.js";
import { compareGrids, summariseField, summariseFrames } from "../lib/spatialCluster/benchStats.js";

const WIDTH = 1140;
const HEIGHT = 540;
const CELL_SIZE = 24;
const MIN_PTS = 8;
// Core cells must be >= 2x the mean occupied-cell density (see mergeCells.js).
const RELATIVE_DENSITY = 2;
const BENCH_DURATION_MS = 10_000;
const POINT_OPTIONS = [5_000, 10_000, 50_000, 100_000];

const COLORS = {
  bg: "#E7DAC2",
  grid: "rgba(185, 174, 156, 0.45)",
  dense: "#FF7A6B",
  denseStroke: "#234B4E",
  sparse: "#3F8487",
  raw: "rgba(35, 75, 78, 0.55)",
  text: "#234B4E",
};

function readQuery() {
  const q = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const points = Number(q.get("points"));
  return {
    backend: BACKEND_ORDER.includes(q.get("backend")) ? q.get("backend") : "webgpu",
    points: Number.isFinite(points) && points > 0 ? Math.min(points, 1_000_000) : 50_000,
    mode: q.get("mode") === "raw" ? "raw" : "clusters",
    autorun: q.get("autorun") === "1",
  };
}

function drawBackground(ctx) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= WIDTH; x += 48) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, HEIGHT);
  }
  for (let y = 0; y <= HEIGHT; y += 48) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(WIDTH, y + 0.5);
  }
  ctx.stroke();
}

function drawClusters(ctx, clusters) {
  ctx.fillStyle = COLORS.sparse;
  ctx.beginPath();
  for (const c of clusters) {
    if (c.dense) continue;
    ctx.moveTo(c.x + 2, c.y);
    ctx.arc(c.x, c.y, 2, 0, Math.PI * 2);
  }
  ctx.fill();

  ctx.font = "13px VT323, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const c of clusters) {
    if (!c.dense) continue;
    const r = Math.max(6, Math.min(c.radius, 6 + Math.log2(c.count) * 3));
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = COLORS.dense;
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(r, c.radius), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.denseStroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (c.count >= 50) {
      ctx.fillStyle = COLORS.text;
      ctx.fillText(String(c.count), c.x, c.y - r - 8);
      ctx.fillStyle = COLORS.dense;
    }
  }
}

function drawRaw(ctx, points) {
  ctx.fillStyle = COLORS.raw;
  for (let i = 0; i < points.length; i += 2) {
    ctx.fillRect(points[i], points[i + 1], 1.5, 1.5);
  }
}

const fmt = (v, digits = 2) => (typeof v === "number" ? v.toFixed(digits) : "—");

export default function WebGPUMap() {
  const initial = useRef(readQuery()).current;
  const [backend, setBackend] = useState(initial.backend);
  const [pointCount, setPointCount] = useState(initial.points);
  const [mode, setMode] = useState(initial.mode);
  const [hud, setHud] = useState(null);
  const [activeBackend, setActiveBackend] = useState(null);
  const [fallbacks, setFallbacks] = useState([]);
  const [benchResult, setBenchResult] = useState(null);
  const [benchRunning, setBenchRunning] = useState(false);

  const canvasRef = useRef(null);
  const clustererRef = useRef(null);
  const simRef = useRef(null);
  const paramsRef = useRef(null);
  const clustersRef = useRef([]);
  const modeRef = useRef(mode);
  const benchRef = useRef(null);
  const inFlightRef = useRef(false);
  const pauseClusteringRef = useRef(false);
  const statsRef = useRef({ frames: [], timings: [], drawMs: [] });

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // (Re)build workload + backend whenever the configuration changes.
  useEffect(() => {
    let cancelled = false;
    let clusterer = null;
    const params = createGridParams({ width: WIDTH, height: HEIGHT, cellSize: CELL_SIZE, maxPoints: pointCount });
    paramsRef.current = params;
    simRef.current = generateIncidents(pointCount, { width: WIDTH, height: HEIGHT });
    clustersRef.current = [];
    setActiveBackend(null);

    createClusterer(params, { preferred: backend })
      .then((c) => {
        if (cancelled) {
          c.destroy();
          return;
        }
        clusterer = c;
        clustererRef.current = c;
        setActiveBackend(c.backend);
        setFallbacks(c.fallbackReasons ?? []);
      })
      .catch((err) => {
        if (!cancelled) setFallbacks([{ backend: "all", reason: err.message }]);
      });

    return () => {
      cancelled = true;
      clustererRef.current = null;
      clusterer?.destroy();
    };
  }, [backend, pointCount]);

  // Render / simulate loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return undefined;
    let raf = 0;
    let last = performance.now();
    let lastHud = last;

    const frame = (now) => {
      const stats = statsRef.current;
      stats.frames.push(now - last);
      last = now;

      const sim = simRef.current;
      if (sim) stepIncidents(sim.points, sim.velocity, WIDTH, HEIGHT);

      const clusterer = clustererRef.current;
      if (sim && clusterer && modeRef.current === "clusters" && !inFlightRef.current && !pauseClusteringRef.current) {
        inFlightRef.current = true;
        const params = paramsRef.current;
        clusterer
          .cluster(sim.points)
          .then(({ grid, timings }) => {
            const t0 = performance.now();
            clustersRef.current = mergeCells(grid, params, { minPts: MIN_PTS, relativeDensity: RELATIVE_DENSITY });
            timings.mergeMs = performance.now() - t0;
            stats.timings.push(timings);
          })
          .catch((err) => {
            // A clusterer torn down by a config change rejects its last frame; ignore that.
            if (clusterer !== clustererRef.current) return;
            setFallbacks((f) => [...f, { backend: clusterer.backend, reason: err.message }]);
          })
          .finally(() => {
            inFlightRef.current = false;
          });
      }

      const d0 = performance.now();
      drawBackground(ctx);
      if (modeRef.current === "raw" && sim) drawRaw(ctx, sim.points);
      else drawClusters(ctx, clustersRef.current);
      stats.drawMs.push(performance.now() - d0);

      if (now - lastHud > 500) {
        lastHud = now;
        const recent = stats.frames.slice(-60);
        setHud({
          frames: summariseFrames(recent),
          total: summariseField(stats.timings.slice(-60), "totalMs"),
          gpuPass: summariseField(stats.timings.slice(-60), "gpuPassMs"),
          merge: summariseField(stats.timings.slice(-60), "mergeMs"),
          draw: summariseField(stats.drawMs.slice(-60).map((ms) => ({ ms })), "ms"),
          clusters: clustersRef.current.filter((c) => c.dense).length,
        });
        if (!benchRef.current) {
          // Keep the rolling window bounded outside of benchmark runs.
          stats.frames = stats.frames.slice(-240);
          stats.timings = stats.timings.slice(-240);
          stats.drawMs = stats.drawMs.slice(-240);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const runBenchmark = useCallback(async () => {
    const clusterer = clustererRef.current;
    if (!clusterer || benchRef.current) return;
    setBenchRunning(true);
    setBenchResult(null);

    // Correctness first: same snapshot through this backend and the CPU oracle.
    // The render loop's clustering is paused so it cannot own the in-flight slot.
    let verification = null;
    if (simRef.current) {
      pauseClusteringRef.current = true;
      while (inFlightRef.current) await new Promise((resolve) => setTimeout(resolve, 5));
      const snapshot = simRef.current.points.slice();
      try {
        const { grid } = await clusterer.cluster(snapshot);
        verification = compareGrids(grid, binPoints(snapshot, paramsRef.current), paramsRef.current.fixedScale);
      } catch (err) {
        verification = { error: err.message };
      } finally {
        pauseClusteringRef.current = false;
      }
    }

    let uploadMs = null;
    if (clusterer.measureUpload && simRef.current) {
      const samples = [];
      for (let i = 0; i < 30; i++) samples.push(await clusterer.measureUpload(simRef.current.points));
      uploadMs = summariseField(samples.map((ms) => ({ ms })), "ms");
    }

    statsRef.current = { frames: [], timings: [], drawMs: [] };
    benchRef.current = true;
    await new Promise((resolve) => setTimeout(resolve, BENCH_DURATION_MS));
    benchRef.current = null;
    const { frames, timings, drawMs } = statsRef.current;

    const result = {
      issue: 608,
      date: new Date().toISOString(),
      userAgent: navigator.userAgent,
      adapter: clusterer.adapterInfo
        ? { vendor: clusterer.adapterInfo.vendor, architecture: clusterer.adapterInfo.architecture, description: clusterer.adapterInfo.description }
        : null,
      requestedBackend: backend,
      backend: clusterer.backend,
      fallbackReasons: clusterer.fallbackReasons ?? [],
      mode: modeRef.current,
      points: pointCount,
      grid: { cellSize: CELL_SIZE, gridW: paramsRef.current.gridW, gridH: paramsRef.current.gridH, minPts: MIN_PTS, relativeDensity: RELATIVE_DENSITY },
      durationMs: BENCH_DURATION_MS,
      frame: summariseFrames(frames),
      clusterTotalMs: summariseField(timings, "totalMs"),
      encodeMs: summariseField(timings, "encodeMs"),
      gpuRoundTripMs: summariseField(timings, "gpuRoundTripMs"),
      gpuPassMs: summariseField(timings, "gpuPassMs"),
      computeMs: summariseField(timings, "computeMs"),
      readbackMs: summariseField(timings, "readbackMs"),
      mergeMs: summariseField(timings, "mergeMs"),
      hostToGpuUploadMs: uploadMs,
      canvasDrawMs: summariseField(drawMs.map((ms) => ({ ms })), "ms"),
      clusterUpdatesPerSec: (timings.length * 1000) / BENCH_DURATION_MS,
      verification,
      gpuMemoryBytes: clusterer.memoryBytes,
      jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
    };
    window.__clusterBench = result;
    setBenchResult(result);
    setBenchRunning(false);
  }, [backend, pointCount]);

  useEffect(() => {
    if (initial.autorun && activeBackend) {
      // Let a few frames settle (shader compile, first map) before measuring.
      const t = setTimeout(runBenchmark, 1500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [initial.autorun, activeBackend, runBenchmark]);

  const label = { fontSize: "12px", color: "#6b6457", display: "flex", flexDirection: "column", gap: "4px" };
  const control = { padding: "6px 8px", borderRadius: "8px", border: "1px solid #C9BCA4", background: "#F2E8D6", color: "#234B4E" };

  return (
    <main style={{ minHeight: "100vh", background: "#ECE0CC", padding: "32px 16px", fontFamily: "system-ui, sans-serif", color: "#234B4E" }}>
      <div style={{ width: "min(1180px, 100%)", margin: "0 auto" }}>
        <h1 style={{ fontFamily: "'Instrument Serif', serif", fontWeight: 400, fontSize: "clamp(28px, 4vw, 44px)", margin: "0 0 6px" }}>
          Spatial clustering lab
        </h1>
        <p style={{ margin: "0 0 20px", color: "#6b6457", fontSize: "14px" }}>
          Feasibility spike #608 — grid-DBSCAN clustering of live SOS points. See ADR-008.
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "14px", alignItems: "flex-end", marginBottom: "16px" }}>
          <label style={label}>
            Preferred backend
            <select style={control} value={backend} onChange={(e) => setBackend(e.target.value)} disabled={benchRunning}>
              {BACKEND_ORDER.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </label>
          <label style={label}>
            Points
            <select style={control} value={pointCount} onChange={(e) => setPointCount(Number(e.target.value))} disabled={benchRunning}>
              {[...new Set([...POINT_OPTIONS, pointCount])].sort((a, b) => a - b).map((n) => (
                <option key={n} value={n}>{n.toLocaleString()}</option>
              ))}
            </select>
          </label>
          <label style={label}>
            Render mode
            <select style={control} value={mode} onChange={(e) => setMode(e.target.value)} disabled={benchRunning}>
              <option value="clusters">Clustered</option>
              <option value="raw">Raw Canvas 2D (baseline)</option>
            </select>
          </label>
          <button
            type="button"
            onClick={runBenchmark}
            disabled={!activeBackend || benchRunning}
            style={{ ...control, background: "#234B4E", color: "#F4ECDC", cursor: "pointer", padding: "7px 14px" }}
          >
            {benchRunning ? `Measuring (${BENCH_DURATION_MS / 1000}s)…` : "Run benchmark"}
          </button>
        </div>

        <div style={{ position: "relative", border: "1px solid #B9AE9C", borderRadius: "18px", overflow: "hidden" }}>
          <canvas
            ref={canvasRef}
            width={WIDTH}
            height={HEIGHT}
            aria-label={`Map of ${pointCount.toLocaleString()} simulated emergency points`}
            style={{ display: "block", width: "100%", height: "auto" }}
          />
          <div
            role="status"
            aria-live="off"
            style={{ position: "absolute", top: "12px", left: "12px", background: "rgba(236, 224, 204, 0.9)", border: "1px solid #C9BCA4", borderRadius: "10px", padding: "8px 12px", fontFamily: "VT323, monospace", fontSize: "16px", lineHeight: 1.25 }}
          >
            <div>backend: {activeBackend ?? "initialising…"}</div>
            <div>fps: {fmt(hud?.frames.fps, 1)} · p95 frame: {fmt(hud?.frames.p95)} ms</div>
            {mode === "clusters" && (
              <>
                <div>cluster p50/p95: {fmt(hud?.total.p50)} / {fmt(hud?.total.p95)} ms</div>
                {hud?.gpuPass.n ? <div>gpu pass p50: {fmt(hud.gpuPass.p50, 3)} ms</div> : null}
                <div>merge p50: {fmt(hud?.merge.p50)} ms · clusters: {hud?.clusters ?? "—"}</div>
              </>
            )}
            <div>canvas draw p50: {fmt(hud?.draw.p50)} ms</div>
          </div>
        </div>

        {fallbacks.length > 0 && (
          <ul style={{ fontSize: "13px", color: "#8a3d33", margin: "12px 0 0", paddingLeft: "18px" }}>
            {fallbacks.map((f, i) => (
              <li key={i}>
                {f.backend} unavailable: {f.reason}
              </li>
            ))}
          </ul>
        )}

        {benchResult && (
          <pre
            data-testid="cluster-bench-result"
            style={{ marginTop: "16px", background: "#F2E8D6", border: "1px solid #C9BCA4", borderRadius: "12px", padding: "14px", fontSize: "12px", overflowX: "auto" }}
          >
            {JSON.stringify(benchResult, null, 2)}
          </pre>
        )}
      </div>
    </main>
  );
}
