// Binary telemetry decode lab (spike, ADR-014).
//
// Streams synthetic map objects (default 10,000/s) in JSON, Protocol
// Buffers, FlatBuffers or Cap'n Proto, decodes them in a requestAnimationFrame
// loop and plots them, then reports dropped frames and decode cost. Used to
// repeat the spike's measurements on real phones.
//
// Mounted at /lab/telemetry-bench. Query params (for scripted runs):
//   ?scenario=flatbuffers/positions  ?frameSize=1000  ?rate=10000  ?seconds=10
//   ?autorun=1  -> runs once; the result is on window.__telemetryBench
// See docs/adr/ADR-014-binary-telemetry-protocol.md.

import { useCallback, useEffect, useRef, useState } from "react";
import { BENCH_SCENARIOS, runTelemetryBench } from "../utils/telemetryBench.js";
import { AnomalyPanel, DivergencePanel, FlagsPanel, ForensicsPanel } from "./TelemetryLabPanels.jsx";

const WASM_URL = new URL("../wasm/telemetry_reader.wasm", import.meta.url).href;
const FRAME_SIZES = [100, 1000, 10000];

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
  };
}

export default function TelemetryLab() {
  const [initial] = useState(readQuery);
  const [scenario, setScenario] = useState(initial.scenario);
  const [frameSize, setFrameSize] = useState(initial.frameSize);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState([]);
  const [error, setError] = useState(null);
  const canvasRef = useRef(null);

  const run = useCallback(async () => {
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
    const t = setTimeout(run, 500);
    return () => clearTimeout(t);
    // Autorun once, with the query-string settings (deliberately no deps).
  }, []);

  const label = { fontSize: "12px", color: "#6b6457", display: "flex", flexDirection: "column", gap: "4px" };
  const control = { padding: "6px 8px", borderRadius: "8px", border: "1px solid #C9BCA4", background: "#F2E8D6", color: "#234B4E" };
  const cell = { padding: "6px 10px", borderBottom: "1px solid #D8CCB6", textAlign: "right", whiteSpace: "nowrap" };

  return (
    <main style={{ minHeight: "100vh", background: "#ECE0CC", padding: "32px 16px", fontFamily: "system-ui, sans-serif", color: "#234B4E" }}>
      <div style={{ width: "min(1180px, 100%)", margin: "0 auto" }}>
        <h1 style={{ fontFamily: "'Instrument Serif', serif", fontWeight: 400, fontSize: "clamp(28px, 4vw, 44px)", margin: "0 0 6px" }}>
          Telemetry decode lab
        </h1>
        <p style={{ margin: "0 0 20px", color: "#6b6457", fontSize: "14px" }}>
          Binary protocol spike: {initial.rate.toLocaleString()} map objects/s decoded and plotted every animation frame. See ADR-014.
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "14px", alignItems: "flex-end", marginBottom: "16px" }}>
          <label style={label}>
            Format / access pattern
            <select style={control} value={scenario} onChange={(e) => setScenario(e.target.value)} disabled={running}>
              {BENCH_SCENARIOS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label style={label}>
            Objects per frame
            <select style={control} value={frameSize} onChange={(e) => setFrameSize(Number(e.target.value))} disabled={running}>
              {[...new Set([...FRAME_SIZES, frameSize])].sort((a, b) => a - b).map((n) => (
                <option key={n} value={n}>{n.toLocaleString()} ({(initial.rate / n).toFixed(0)} Hz)</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={run}
            disabled={running}
            style={{ ...control, background: "#234B4E", color: "#F4ECDC", cursor: "pointer", padding: "7px 14px" }}
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
                    <th key={h} style={{ ...cell, textAlign: h === "scenario" ? "left" : "right", color: "#6b6457", fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i}>
                    <td style={{ ...cell, textAlign: "left" }}>{r.scenario}</td>
                    <td style={cell}>{r.frameSize.toLocaleString()}</td>
                    <td style={cell}>{r.frameBytes.toLocaleString()}</td>
                    <td style={cell}>{r.nsPerObject}</td>
                    <td style={cell}>{r.decodePerFrameMs?.p99}</td>
                    <td style={cell}>{r.droppedFrames}</td>
                    <td style={cell}>{r.longFrames50ms}</td>
                    <td style={cell}>{r.rafIntervalMs?.p99}</td>
                    <td style={cell}>{r.heapAfterMB ?? "n/a (not Chromium)"}</td>
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
    </main>
  );
}
