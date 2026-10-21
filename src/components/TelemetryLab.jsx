import { useEffect, useMemo, useState } from 'react';
import {
  getTelemetryLabController,
  type LabSnapshot,
} from '../lib/telemetryLabController';
import type { NetworkClass } from '../lib/networkEstimator';

const COLORS = {
  ink: '#234B4E',
  coral: '#FF7A6B',
  purple: '#7357FF',
  green: '#2F7D5B',
  cream: '#ECE0CC',
  muted: '#6b7a76',
  line: 'rgba(35,75,78,0.14)',
};

const CARD: React.CSSProperties = {
  background: '#fff',
  border: `1px solid ${COLORS.line}`,
  borderRadius: 14,
  padding: '14px 16px',
  minWidth: 150,
  flex: '1 1 150px',
};

function metric(label: string, value: number | string, hint?: string) {
  return (
    <div style={CARD} key={label}>
      <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: COLORS.muted }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: COLORS.ink, fontVariantNumeric: 'tabular-nums' }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {hint ? <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 2 }}>{hint}</div> : null}
    </div>
  );
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Truthful live view of produced / parsed / dropped / exported.
 *
 * The old TelemetryLab rendered a smooth throughput graph because it polled a
 * monotonic drop counter too slowly. This view polls the pipeline snapshot
 * every second, shows every drop reason, and marks conservation red the moment
 * produced ≠ exported + queued + dropped.
 */
export default function TelemetryLab() {
  const controller = useMemo(() => getTelemetryLabController(), []);
  const [snapshot, setSnapshot] = useState<LabSnapshot>(() => controller.snapshot());
  const [rate, setRate] = useState(500);
  const [network, setNetwork] = useState<NetworkClass>('4g');

  useEffect(() => {
    const timer = setInterval(() => setSnapshot(controller.snapshot()), 1_000);
    return () => clearInterval(timer);
  }, [controller]);

  useEffect(() => () => controller.destroy(), [controller]);

  const reasons = snapshot.droppedReasons;
  const reasonTotal = Object.values(reasons).reduce((a, b) => a + b, 0);
  const conservation = snapshot.conservation;

  return (
    <main style={{ minHeight: '100vh', background: COLORS.cream, padding: '32px 24px', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <header style={{ maxWidth: 1180, margin: '0 auto 20px' }}>
        <div style={{ fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase', color: COLORS.coral, fontWeight: 700 }}>
          Telemetry Lab
        </div>
        <h1 style={{ margin: '4px 0 6px', color: COLORS.ink, fontSize: 34 }}>Produced → parsed → exported, with reasons</h1>
        <p style={{ margin: 0, color: COLORS.muted, maxWidth: 780 }}>
          Every counter below is derived from the same ring-buffer snapshot the pipeline uses for backpressure.
          Start a flood, then watch the worker pause at 90% occupancy and the drop ledger explain each shed frame.
        </p>
      </header>

      <section style={{ maxWidth: 1180, margin: '0 auto', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <button
          type="button"
          onClick={() => {
            if (snapshot.lab.running) controller.stop();
            else {
              controller.setRate(rate);
              controller.start();
            }
            setSnapshot(controller.snapshot());
          }}
          style={{ background: snapshot.lab.running ? COLORS.coral : COLORS.ink, color: '#fff', border: 0, borderRadius: 10, padding: '11px 18px', fontWeight: 700, cursor: 'pointer' }}
        >
          {snapshot.lab.running ? 'Stop flood' : 'Start flood'}
        </button>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.ink, fontSize: 13 }}>
          Rate
          <input
            type="range"
            min={50}
            max={2000}
            step={50}
            value={rate}
            onChange={(event) => {
              const next = Number(event.target.value);
              setRate(next);
              controller.setRate(next);
            }}
          />
          <span style={{ fontVariantNumeric: 'tabular-nums', width: 58 }}>{rate}/s</span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.ink, fontSize: 13 }}>
          Network
          <select
            value={network}
            onChange={(event) => {
              const next = event.target.value as NetworkClass;
              setNetwork(next);
              controller.setNetwork(next);
            }}
            style={{ padding: '7px 10px', borderRadius: 8, border: `1px solid ${COLORS.line}` }}
          >
            <option value="4g">4G</option>
            <option value="3g">3G</option>
            <option value="2g">2G</option>
            <option value="offline">Offline</option>
          </select>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.ink, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={snapshot.lab.collectorDown}
            onChange={(event) => {
              controller.setCollectorDown(event.target.checked);
              setSnapshot(controller.snapshot());
            }}
          />
          Collector down
        </label>

        <button
          type="button"
          onClick={() => void controller.flush().then(() => setSnapshot(controller.snapshot()))}
          style={{ background: '#fff', color: COLORS.ink, border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: '10px 16px', fontWeight: 600, cursor: 'pointer' }}
        >
          Flush now
        </button>

        <span
          role="status"
          style={{
            alignSelf: 'center',
            marginLeft: 'auto',
            background: conservation.ok ? 'rgba(47,125,91,0.12)' : 'rgba(255,122,107,0.16)',
            color: conservation.ok ? COLORS.green : COLORS.coral,
            padding: '8px 12px',
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {conservation.ok ? 'Accounting balanced' : 'Accounting mismatch'} · accounted {conservation.accounted.toLocaleString()}
        </span>
      </section>

      <section style={{ maxWidth: 1180, margin: '16px auto 0', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {metric('Produced', snapshot.produced, 'frames offered')}
        {metric('Parsed', snapshot.parsed, `${snapshot.lab.workerMode}`)}
        {metric('Admitted', snapshot.admitted, 'ring accepted')}
        {metric('Dropped', snapshot.dropped, `${pct(snapshot.produced ? snapshot.dropped / snapshot.produced : 0)} of produced`)}
        {metric('Exported', snapshot.exported, snapshot.exportFailed ? `${snapshot.exportFailed} failed` : 'collector OK')}
        {metric('Queue', snapshot.queueDepth, `${pct(snapshot.occupancy)} occupancy`)}
        {metric('Pressure', snapshot.pressure, `${snapshot.networkClass} profile`)}
        {metric('Sampled', snapshot.sampled, `normal ${pct(snapshot.profile.normalSampleRate)}`)}
      </section>

      <section style={{ maxWidth: 1180, margin: '16px auto 0', display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(260px, 1fr)', gap: 14 }}>
        <div style={{ ...CARD, padding: 18 }}>
          <h2 style={{ margin: '0 0 10px', color: COLORS.ink, fontSize: 18 }}>Drop ledger</h2>
          {reasonTotal === 0 ? (
            <p style={{ color: COLORS.muted, margin: 0 }}>No drops recorded yet.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: COLORS.muted }}>
                  <th style={{ padding: '6px 0', fontWeight: 600 }}>Reason</th>
                  <th style={{ padding: '6px 0', fontWeight: 600, textAlign: 'right' }}>Count</th>
                  <th style={{ padding: '6px 0', fontWeight: 600, textAlign: 'right' }}>Share</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(reasons)
                  .filter(([, count]) => count > 0)
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, count]) => (
                    <tr key={reason} style={{ borderTop: `1px solid ${COLORS.line}` }}>
                      <td style={{ padding: '7px 0', color: COLORS.ink }}>{reason}</td>
                      <td style={{ padding: '7px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{count.toLocaleString()}</td>
                      <td style={{ padding: '7px 0', textAlign: 'right', color: COLORS.muted }}>{pct(count / reasonTotal)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}

          <div style={{ marginTop: 14, fontSize: 12, color: COLORS.muted, lineHeight: 1.6 }}>
            Priority policy: heartbeat evicted first, then normal, then critical. At 90% occupancy the producer
            sheds non-critical frames with <code>because=backpressure</code>; dispatch-critical frames are never
            sampled.
          </div>
        </div>

        <div style={{ ...CARD, padding: 18 }}>
          <h2 style={{ margin: '0 0 10px', color: COLORS.ink, fontSize: 18 }}>Batch profile</h2>
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px 12px', fontSize: 13 }}>
            <dt style={{ color: COLORS.muted }}>maxQueueSize</dt><dd style={{ margin: 0, textAlign: 'right' }}>{snapshot.profile.maxQueueSize}</dd>
            <dt style={{ color: COLORS.muted }}>scheduledDelayMillis</dt><dd style={{ margin: 0, textAlign: 'right' }}>{snapshot.profile.scheduledDelayMillis}</dd>
            <dt style={{ color: COLORS.muted }}>maxExportBatchSize</dt><dd style={{ margin: 0, textAlign: 'right' }}>{snapshot.profile.maxExportBatchSize}</dd>
            <dt style={{ color: COLORS.muted }}>heartbeat sample</dt><dd style={{ margin: 0, textAlign: 'right' }}>{pct(snapshot.profile.heartbeatSampleRate)}</dd>
            <dt style={{ color: COLORS.muted }}>outbox only</dt><dd style={{ margin: 0, textAlign: 'right' }}>{snapshot.profile.outboxOnly ? 'yes' : 'no'}</dd>
            <dt style={{ color: COLORS.muted }}>exporter</dt><dd style={{ margin: 0, textAlign: 'right', color: snapshot.exporterHealthy ? COLORS.green : COLORS.coral }}>{snapshot.exporterHealthy ? 'healthy' : 'retrying'}</dd>
            <dt style={{ color: COLORS.muted }}>outboxed</dt><dd style={{ margin: 0, textAlign: 'right' }}>{snapshot.outboxed.toLocaleString()}</dd>
          </dl>
          {snapshot.lastError ? (
            <p style={{ margin: '12px 0 0', color: COLORS.coral, fontSize: 12 }}>{snapshot.lastError}</p>
          ) : null}
        </div>
      </section>

      <footer style={{ maxWidth: 1180, margin: '18px auto 0', color: COLORS.muted, fontSize: 12 }}>
        Also available at <code>/lab/telemetry</code>. Snapshot refreshes every 1s; the ring never overwrites
        without incrementing a reason.
      </footer>
    </main>
  );
}
