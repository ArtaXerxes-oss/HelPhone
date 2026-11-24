// Unified TelemetryLab:
// Tab 1: Live Pipeline Backpressure & Drop Ledger (ISP-032)
// Tab 2: Binary Telemetry Codec & Render Benchmark (ADR-014)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getTelemetryLabController,
} from "../lib/telemetryLabController";
import { BENCH_SCENARIOS, runTelemetryBench } from "../utils/telemetryBench.js";
import { AnomalyPanel, DivergencePanel, FlagsPanel, ForensicsPanel } from "./TelemetryLabPanels.jsx";

const WASM_URL = new URL("../wasm/telemetry_reader.wasm", import.meta.url).href;
const FRAME_SIZES = [100, 1000, 10000];

const COLORS = {
  ink: "#234B4E",
  coral: "#FF7A6B",
  purple: "#7357FF",
  green: "#2F7D5B",
  cream: "#ECE0CC",
  muted: "#6b7a76",
  line: "rgba(35,75,78,0.14)",
};

const CARD = {
  background: "#fff",
  border: `1px solid ${COLORS.line}`,
  borderRadius: 14,
  padding: "14px 16px",
  minWidth: 150,
  flex: "1 1 150px",
};

function metric(label, value, hint) {
  return (
    <div style={CARD} key={label}>
      <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: COLORS.muted }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: COLORS.ink, fontVariantNumeric: "tabular-nums" }}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      {hint ? <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 2 }}>{hint}</div> : null}
    </div>
  );
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function readQuery() {
  const q = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const num = (key, fallback) => {
    const n = Number(q.get(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    scenario: BENCH_SCENARIOS.includes(q.get("scenario")) ? q.get("scenario") : "flatbuffers/positions",
    frameSize: num("frameSize", 1000),
    rate: num("rate", 10000),
    seconds: num("seconds", 10),
    autorun: q.get("autorun") === "1",
    tab: q.get("tab") || (typeof window !== "undefined" && window.location.pathname.includes("bench") ? "bench" : "pipeline"),
  };
}

export default function TelemetryLab() {
  const [initial] = useState(readQuery);
  const [activeTab, setActiveTab] = useState(initial.tab);

  // Pipeline Controller state
  const controller = useMemo(() => getTelemetryLabController(), []);
  const [snapshot, setSnapshot] = useState(() => controller.snapshot());
  const [pipelineRate, setPipelineRate] = useState(500);
  const [network, setNetwork] = useState("4g");

  useEffect(() => {
    const timer = setInterval(() => setSnapshot(controller.snapshot()), 1000);
    return () => clearInterval(timer);
  }, [controller]);

  useEffect(() => () => controller.destroy(), [controller]);

  // Benchmark state
  const [scenario, setScenario] = useState(initial.scenario);
  const [frameSize, setFrameSize] = useState(initial.frameSize);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState([]);
  const [error, setError] = useState(null);
  const canvasRef = useRef(null);

  const runBench = useCallback(async () => {
    setRunning(true);
    setError(null);
    setProgress(0);
    try {
      const result = await runTelemetryBench({
        scenario,
        frameSize,
        rate: initial.rate,
        seconds: initial.seconds,
        canvas: canvasRef.current,
        wasmUrl: WASM_URL,
        onProgress: setProgress,
      });
      const withAgent = { ...result, userAgent: navigator.userAgent, date: new Date().toISOString() };
      window.__telemetryBench = withAgent;
      setResults((r) => [withAgent, ...r]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [scenario, frameSize, initial.rate, initial.seconds]);

  useEffect(() => {
    if (!initial.autorun) return undefined;
    const t = setTimeout(runBench, 500);
    return () => clearTimeout(t);
  }, []);

  const reasons = snapshot.droppedReasons;
  const reasonTotal = Object.values(reasons).reduce((a, b) => a + b, 0);

  const labelStyle = { fontSize: "12px", color: "#6b6457", display: "flex", flexDirection: "column", gap: "4px" };
  const controlStyle = { padding: "6px 8px", borderRadius: "8px", border: "1px solid #C9BCA4", background: "#F2E8D6", color: "#234B4E" };
  const cellStyle = { padding: "6px 10px", borderBottom: "1px solid #D8CCB6", textAlign: "right", whiteSpace: "nowrap" };

  return (
    <main style={{ minHeight: "100vh", background: COLORS.cream, padding: "32px 24px", fontFamily: "Inter, system-ui, sans-serif" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto 20px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: COLORS.coral, fontWeight: 700 }}>
            Telemetry Lab
          </div>
          <h1 style={{ margin: "4px 0 6px", color: COLORS.ink, fontSize: 32 }}>
            {activeTab === "pipeline" ? "Produced → parsed → exported, with reasons" : "Telemetry decode & render benchmark"}
          </h1>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => setActiveTab("pipeline")}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: `1px solid ${COLORS.ink}`,
              background: activeTab === "pipeline" ? COLORS.ink : "#fff",
              color: activeTab === "pipeline" ? "#fff" : COLORS.ink,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Live Pipeline (Backpressure)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("bench")}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: `1px solid ${COLORS.ink}`,
              background: activeTab === "bench" ? COLORS.ink : "#fff",
              color: activeTab === "bench" ? "#fff" : COLORS.ink,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Codec Benchmark (ADR-014)
          </button>
        </div>
      </div>

      {activeTab === "pipeline" ? (
        <>
          <section style={{ maxWidth: 1180, margin: "0 auto", display: "flex", flexWrap: "wrap", gap: 10 }}>
            <button
              type="button"
              onClick={() => {
                if (snapshot.lab.running) controller.stop();
                else {
                  controller.setRate(pipelineRate);
                  controller.start();
                }
                setSnapshot(controller.snapshot());
              }}
              style={{ background: snapshot.lab.running ? COLORS.coral : COLORS.ink, color: "#fff", border: 0, borderRadius: 10, padding: "11px 18px", fontWeight: 700, cursor: "pointer" }}
            >
              {snapshot.lab.running ? "Stop flood" : "Start flood"}
            </button>

            <label style={{ display: "flex", alignItems: "center", gap: 8, color: COLORS.ink, fontSize: 13 }}>
              Rate
              <input
                type="range"
                min={50}
                max={2000}
                step={50}
                value={pipelineRate}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setPipelineRate(next);
                  controller.setRate(next);
                }}
              />
              <span style={{ fontVariantNumeric: "tabular-nums", width: 58 }}>{pipelineRate}/s</span>
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: 8, color: COLORS.ink, fontSize: 13 }}>
              Network
              <select
                value={network}
                onChange={(event) => {
                  const next = event.target.value;
                  setNetwork(next);
                  controller.setNetwork(next);
                }}
                style={{ padding: "7px 10px", borderRadius: 8, border: `1px solid ${COLORS.line}` }}
              >
                <option value="4g">4G (fast, large batches)</option>
                <option value="3g">3G (throttled)</option>
                <option value="2g">2G (severe sampling)</option>
                <option value="offline">Offline (outbox only)</option>
              </select>
            </label>

            <button
              type="button"
              onClick={() => {
                controller.burst(200);
                setSnapshot(controller.snapshot());
              }}
              style={{ background: "#fff", border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: "9px 14px", color: COLORS.ink, fontWeight: 600, cursor: "pointer" }}
            >
              Burst 200
            </button>
            <button
              type="button"
              onClick={() => {
                controller.toggleCollector();
                setSnapshot(controller.snapshot());
              }}
              style={{ background: snapshot.lab.collectorDown ? COLORS.coral : "#fff", color: snapshot.lab.collectorDown ? "#fff" : COLORS.ink, border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: "9px 14px", fontWeight: 600, cursor: "pointer" }}
            >
              {snapshot.lab.collectorDown ? "Restore collector" : "Simulate collector outage"}
            </button>
            <button
              type="button"
              onClick={() => {
                controller.reset();
                setSnapshot(controller.snapshot());
              }}
              style={{ background: "#fff", border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: "9px 14px", color: COLORS.muted, cursor: "pointer" }}
            >
              Reset counters
            </button>
          </section>

          <section style={{ maxWidth: 1180, margin: "16px auto 0", display: "flex", flexWrap: "wrap", gap: 10 }}>
            {metric("Produced", snapshot.produced, "frames offered")}
            {metric("Parsed", snapshot.parsed, `${snapshot.lab.workerMode}`)}
            {metric("Admitted", snapshot.admitted, "ring accepted")}
            {metric("Dropped", snapshot.dropped, `${pct(snapshot.produced ? snapshot.dropped / snapshot.produced : 0)} of produced`)}
            {metric("Exported", snapshot.exported, snapshot.exportFailed ? `${snapshot.exportFailed} failed` : "collector OK")}
            {metric("Queue", snapshot.queueDepth, `${pct(snapshot.occupancy)} occupancy`)}
            {metric("Pressure", snapshot.pressure, `${snapshot.networkClass} profile`)}
            {metric("Sampled", snapshot.sampled, `normal ${pct(snapshot.profile.normalSampleRate)}`)}
          </section>

          <section style={{ maxWidth: 1180, margin: "16px auto 0", display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(260px, 1fr)", gap: 14 }}>
            <div style={{ ...CARD, padding: 18 }}>
              <h2 style={{ margin: "0 0 10px", color: COLORS.ink, fontSize: 18 }}>Drop ledger</h2>
              {reasonTotal === 0 ? (
                <p style={{ color: COLORS.muted, margin: 0 }}>No drops recorded yet.</p>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: COLORS.muted }}>
                      <th style={{ padding: "6px 0", fontWeight: 600 }}>Reason</th>
                      <th style={{ padding: "6px 0", fontWeight: 600, textAlign: "right" }}>Count</th>
                      <th style={{ padding: "6px 0", fontWeight: 600, textAlign: "right" }}>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(reasons)
                      .filter(([, count]) => count > 0)
                      .sort((a, b) => b[1] - a[1])
                      .map(([reason, count]) => (
                        <tr key={reason} style={{ borderTop: `1px solid ${COLORS.line}` }}>
                          <td style={{ padding: "7px 0", color: COLORS.ink }}>{reason}</td>
                          <td style={{ padding: "7px 0", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{count.toLocaleString()}</td>
                          <td style={{ padding: "7px 0", textAlign: "right", color: COLORS.muted }}>{pct(count / reasonTotal)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </div>

            <div style={{ ...CARD, padding: 18 }}>
              <h2 style={{ margin: "0 0 10px", color: COLORS.ink, fontSize: 18 }}>Batch profile</h2>
              <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "1fr auto", gap: "8px 12px", fontSize: 13 }}>
                <dt style={{ color: COLORS.muted }}>maxQueueSize</dt><dd style={{ margin: 0, textAlign: "right" }}>{snapshot.profile.maxQueueSize}</dd>
                <dt style={{ color: COLORS.muted }}>scheduledDelayMillis</dt><dd style={{ margin: 0, textAlign: "right" }}>{snapshot.profile.scheduledDelayMillis}</dd>
                <dt style={{ color: COLORS.muted }}>maxExportBatchSize</dt><dd style={{ margin: 0, textAlign: "right" }}>{snapshot.profile.maxExportBatchSize}</dd>
                <dt style={{ color: COLORS.muted }}>heartbeat sample</dt><dd style={{ margin: 0, textAlign: "right" }}>{pct(snapshot.profile.heartbeatSampleRate)}</dd>
                <dt style={{ color: COLORS.muted }}>outbox only</dt><dd style={{ margin: 0, textAlign: "right" }}>{snapshot.profile.outboxOnly ? "yes" : "no"}</dd>
                <dt style={{ color: COLORS.muted }}>exporter</dt><dd style={{ margin: 0, textAlign: "right", color: snapshot.exporterHealthy ? COLORS.green : COLORS.coral }}>{snapshot.exporterHealthy ? "healthy" : "retrying"}</dd>
                <dt style={{ color: COLORS.muted }}>outboxed</dt><dd style={{ margin: 0, textAlign: "right" }}>{snapshot.outboxed.toLocaleString()}</dd>
              </dl>
            </div>
          </section>
        </>
      ) : (
        <div style={{ width: "min(1180px, 100%)", margin: "0 auto" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "14px", alignItems: "flex-end", marginBottom: "16px" }}>
            <label style={labelStyle}>
              Format / access pattern
              <select style={controlStyle} value={scenario} onChange={(e) => setScenario(e.target.value)} disabled={running}>
                {BENCH_SCENARIOS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            <label style={labelStyle}>
              Objects per frame
              <select style={controlStyle} value={frameSize} onChange={(e) => setFrameSize(Number(e.target.value))} disabled={running}>
                {[...new Set([...FRAME_SIZES, frameSize])].sort((a, b) => a - b).map((n) => (
                  <option key={n} value={n}>{n.toLocaleString()} ({(initial.rate / n).toFixed(0)} Hz)</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={runBench}
              disabled={running}
              style={{ ...controlStyle, background: "#234B4E", color: "#F4ECDC", cursor: "pointer", padding: "7px 14px" }}
            >
              {running ? `Measuring… ${Math.round(progress * 100)}%` : `Run (${initial.seconds}s)`}
            </button>
          </div>

          <div style={{ border: "1px solid #B9AE9C", borderRadius: "18px", overflow: "hidden", background: "#E7DAC2" }}>
            <canvas
              ref={canvasRef}
              width={960}
              height={420}
              aria-label="Simulated responder and SOS positions"
              style={{ display: "block", width: "100%", height: "auto" }}
            />
          </div>

          {error && <p role="alert" style={{ color: "#8a3d33", fontSize: "13px" }}>{error}</p>}

          {results.length > 0 && (
            <div style={{ overflowX: "auto", marginTop: "16px" }}>
              <table data-testid="telemetry-bench-results" style={{ borderCollapse: "collapse", fontSize: "13px", fontVariantNumeric: "tabular-nums" }}>
                <thead>
                  <tr>
                    {["scenario", "objects/frame", "bytes/frame", "ns/object", "decode p99 ms", "dropped frames", "frames > 50 ms", "rAF p99 ms", "heap MB"].map((h) => (
                      <th key={h} style={{ ...cellStyle, textAlign: h === "scenario" ? "left" : "right", color: "#6b6457", fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i}>
                      <td style={{ ...cellStyle, textAlign: "left" }}>{r.scenario}</td>
                      <td style={cellStyle}>{r.frameSize.toLocaleString()}</td>
                      <td style={cellStyle}>{r.frameBytes.toLocaleString()}</td>
                      <td style={cellStyle}>{r.nsPerObject}</td>
                      <td style={cellStyle}>{r.decodePerFrameMs?.p99}</td>
                      <td style={cellStyle}>{r.droppedFrames}</td>
                      <td style={cellStyle}>{r.longFrames50ms}</td>
                      <td style={cellStyle}>{r.rafIntervalMs?.p99}</td>
                      <td style={cellStyle}>{r.heapAfterMB ?? "n/a (not Chromium)"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <AnomalyPanel />
          <ForensicsPanel />
          <FlagsPanel />
          <DivergencePanel />
        </div>
      )}
    </main>
  );
}
