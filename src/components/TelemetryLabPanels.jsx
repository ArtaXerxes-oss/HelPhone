// Field-diagnostics panels for the telemetry lab (#793, #796, #797).
//
//   ForensicsPanel  — "Force forensic snapshot" + per-subsystem bytes bar chart,
//                     with measured vs estimated labelled per signal.
//   FlagsPanel      — kill-switch snapshot: version, staleness per switch.
//   DivergencePanel — synthetic vs RUM p95 for one route/step/cohort and the
//                     paging decision the server would take.
//
// Lives in the lazily loaded lab chunk; nothing here ships on the critical path.

import { useEffect, useState } from "react";
import { breakdown, buildEnvelope, emitEnvelope, sample, SIGNAL_KIND } from "../lib/heapForensics.ts";
import { currentFlagSnapshot, evaluateKillSwitch, KILL_SWITCH_POLICIES, onFlagSnapshot } from "../lib/featureFlags.ts";
import { detectAnomalies, groupAlerts, sampleSpans } from "../lib/anomalyDetector.ts";

const card = { border: "1px solid #C9BCA4", borderRadius: "14px", padding: "14px 16px", background: "#F2E8D6", marginTop: "16px" };
const muted = { color: "#6b6457", fontSize: "12px" };
const button = { padding: "7px 14px", borderRadius: "8px", border: "1px solid #C9BCA4", background: "#234B4E", color: "#F4ECDC", cursor: "pointer" };
const STALENESS_COLOR = { fresh: "#3F8487", stale: "#a2a586", expired: "#FF7A6B" };

const fmtBytes = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export function ForensicsPanel() {
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState(null);

  const snapshot = () => {
    sample();
    const env = buildEnvelope("manual");
    const sent = emitEnvelope(env, { force: true });
    setRows(Object.entries(breakdown()).sort((a, b) => b[1] - a[1]));
    setStatus(sent ? `Sent ${env.census.length} census rows (${env.ua}).` : "Upload failed; snapshot kept locally.");
  };

  const max = Math.max(1, ...rows.map(([, v]) => v));
  return (
    <section style={card} aria-labelledby="forensics-h">
      <h2 id="forensics-h" style={{ margin: "0 0 8px", fontSize: "16px" }}>Memory forensics</h2>
      <p style={{ ...muted, margin: "0 0 10px" }}>
        Per-subsystem attribution without DevTools. Signals a browser cannot measure are omitted, not shown as zero.
      </p>
      <button type="button" style={button} onClick={snapshot}>Force forensic snapshot</button>
      {status && <p role="status" style={{ ...muted, margin: "8px 0 0" }}>{status}</p>}
      {rows.length > 0 && (
        <div data-testid="forensics-breakdown" style={{ marginTop: "12px", display: "grid", gap: "6px" }}>
          {rows.map(([name, value]) => (
            <div key={name} style={{ display: "grid", gridTemplateColumns: "minmax(110px, 160px) 1fr auto", gap: "8px", alignItems: "center", fontSize: "12px" }}>
              <span>{name} <span style={muted}>({SIGNAL_KIND[name]})</span></span>
              <div style={{ background: "#E7DAC2", borderRadius: "4px", height: "10px" }}>
                <div style={{ width: `${(value / max) * 100}%`, height: "100%", borderRadius: "4px", background: name === "jsHeapUsed" ? "#234B4E" : "#7357FF" }} />
              </div>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtBytes(value)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function FlagsPanel() {
  const [snap, setSnap] = useState(currentFlagSnapshot);
  const [, tick] = useState(0);
  useEffect(() => onFlagSnapshot(setSnap), []);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <section style={card} aria-labelledby="flags-h">
      <h2 id="flags-h" style={{ margin: "0 0 8px", fontSize: "16px" }}>Kill-switches</h2>
      <p style={{ ...muted, margin: "0 0 10px" }}>
        Flag version <strong>{snap.version}</strong>
        {snap.fetchedAt ? ` · fetched ${Math.round((Date.now() - snap.fetchedAt) / 1000)}s ago` : " · never fetched"}
      </p>
      <table style={{ borderCollapse: "collapse", fontSize: "12px" }}>
        <tbody>
          {Object.keys(KILL_SWITCH_POLICIES).map((key) => {
            const r = evaluateKillSwitch(key);
            return (
              <tr key={key}>
                <td style={{ padding: "3px 10px 3px 0" }}>{key}</td>
                <td style={{ padding: "3px 10px" }}>{r.enabled ? "on" : "killed"}</td>
                <td style={{ padding: "3px 0", color: STALENESS_COLOR[r.staleness] }}>{r.staleness}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** Anomaly precision panel (#773): groups burst alerts and correlates deploy/flag markers. */
export function AnomalyPanel() {
  const [alerts, setAlerts] = useState([]);
  const [kept, setKept] = useState(0);
  const [total, setTotal] = useState(0);

  const run = () => {
    const now = Date.now();
    // Synthetic burst: many short ok spans + one stalled retry chain.
    const spans = [];
    for (let i = 0; i < 40; i++) {
      spans.push({
        traceId: `healthy-${i}`,
        spanId: `s-${i}`,
        name: "dispatch",
        durationMs: 120 + (i % 5) * 10,
        status: "ok",
        at: now + i * 100,
      });
    }
    const stallTrace = "stall-1";
    for (let i = 0; i < 6; i++) {
      spans.push({
        traceId: stallTrace,
        spanId: `stall-${i}`,
        name: "syncManager.retry",
        durationMs: 700,
        status: "ok",
        at: now + 5000 + i * 200,
        parentSpanId: i === 0 ? undefined : `stall-${i - 1}`,
      });
    }
    const markers = [
      { kind: "deploy", at: now - 60_000, label: "deploy:lab" },
      { kind: "flag_flip", at: now + 1000, label: "flag:anomalyDetectorV2" },
    ];
    const sampled = sampleSpans(spans, { headSampleRatio: 0.1, causalKeepRatio: 0.95 });
    const raw = detectAnomalies(sampled, markers);
    const grouped = groupAlerts(raw);
    setKept(sampled.length);
    setTotal(spans.length);
    setAlerts(grouped);
  };

  return (
    <section style={card} aria-labelledby="anomaly-h">
      <h2 id="anomaly-h" style={{ margin: "0 0 8px", fontSize: "16px" }}>Anomaly detector</h2>
      <p style={{ ...muted, margin: "0 0 10px" }}>
        Burst-aware paging with deploy/flag correlation. One burst → one banner (#773).
      </p>
      <button type="button" style={button} onClick={run}>Replay burst scenario</button>
      {total > 0 && (
        <p style={{ ...muted, margin: "8px 0 0" }}>
          Kept {kept}/{total} spans (causal chain preserved for stalls).
        </p>
      )}
      {alerts.length > 0 && (
        <ul data-testid="anomaly-alerts" style={{ margin: "10px 0 0", paddingInlineStart: "18px", fontSize: "12px" }}>
          {alerts.map((a) => (
            <li key={a.id}>
              <strong>{a.severity}</strong> — {a.reason}
              {a.correlatedMarkers.length > 0 ? ` · markers: ${a.correlatedMarkers.join(", ")}` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DivergencePanel({ route = "/help", step = "tapToConfirm", cohort = "default" }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    const q = new URLSearchParams({ route, step, cohort });
    fetch(`/api/telemetry/divergence?${q}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setData, (e) => setError(e.message));
  }, [route, step, cohort]);

  const fmt = (s) => (s == null ? "no data" : s === Infinity ? "> max bucket" : `${s}s`);
  return (
    <section style={card} aria-labelledby="div-h">
      <h2 id="div-h" style={{ margin: "0 0 8px", fontSize: "16px" }}>Synthetic vs field</h2>
      {error && <p style={muted}>Unavailable ({error}).</p>}
      {data && (
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 14px", fontSize: "12px", margin: 0 }}>
          <dt style={muted}>Slice</dt><dd style={{ margin: 0 }}>{data.route} · {data.step} · {data.cohort}</dd>
          <dt style={muted}>Field RUM p95</dt><dd style={{ margin: 0 }}>{fmt(data.rumP95)} ({data.rumCount} samples)</dd>
          <dt style={muted}>Synthetic p95</dt><dd style={{ margin: 0 }}>{fmt(data.syntheticP95)}</dd>
          <dt style={muted}>Budget</dt><dd style={{ margin: 0 }}>{data.budgetSeconds}s</dd>
          <dt style={muted}>RUM coverage</dt><dd style={{ margin: 0 }}>{data.coverage == null ? "unknown" : `${Math.round(data.coverage * 100)}% (lower bound)`}</dd>
          <dt style={muted}>Decision</dt><dd style={{ margin: 0, fontWeight: 600 }}>{data.decision}</dd>
        </dl>
      )}
    </section>
  );
}
