/**
 * ETA calibration dashboard (ADR-022 follow-up).
 *
 * Compares the displayed ETA range with the realized arrival time by mode,
 * using the committed redacted dataset plus any locally recorded outcomes.
 * Linked from ADR-022 and `/lab/eta-calibration`.
 */

import { Link } from 'react-router-dom'
import observations from '../../data/eta-calibration/observations.json'
import fitted from '../../data/eta-calibration/fitted-constants.json'
import { loadCalibrationRecords, summarizeByMode, type CalibrationRecord } from '../lib/calibration'
import { FITTED_ETA_CONSTANTS, LEGACY_ETA_CONSTANTS } from '../lib/etaConstants'

function datasetRecords(): CalibrationRecord[] {
  return observations.observations.map((o) => {
    const midpointMin = (o.displayed_min + o.displayed_max) / 2
    const realizedMin = o.eta_realized / 60
    return {
      ts: 0,
      mode: o.mode as CalibrationRecord['mode'],
      area: o.area,
      displayedMin: o.displayed_min,
      displayedMax: o.displayed_max,
      confidence: o.mode === 'traffic' ? 'normal' : 'low',
      confidenceScore: 0,
      degraded: o.mode !== 'traffic',
      etaRealizedSeconds: o.eta_realized,
      errorSeconds: Math.round(Math.abs(realizedMin - midpointMin) * 60),
      withinRange: realizedMin >= o.displayed_min && realizedMin <= o.displayed_max,
    }
  })
}

const cell = { padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)' } as const
const head = { ...cell, fontSize: '11px', letterSpacing: '1px', color: '#a2a586', textAlign: 'left' as const }

export default function CalibrationDashboard() {
  const records = [...datasetRecords(), ...loadCalibrationRecords()]
  const summaries = summarizeByMode(records)
  const fit = fitted.fitted as unknown as Record<string, number>
  const legacy = fitted.legacy as unknown as Record<string, number>

  return (
    <main style={{ background: '#1c2c24', color: '#F4ECDC', minHeight: '100vh', padding: '32px 20px', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <nav style={{ marginBottom: 24 }}>
          <Link to="/" style={{ color: '#3F8487' }}>← HelPhone</Link>
          <span style={{ margin: '0 10px', opacity: 0.4 }}>/</span>
          <Link to="/help" style={{ color: '#3F8487' }}>Help</Link>
        </nav>

        <h1 style={{ fontFamily: "'Instrument Serif', serif", fontWeight: 400, fontSize: 32, margin: '0 0 8px' }}>
          ETA calibration
        </h1>
        <p style={{ opacity: 0.6, fontSize: 13, marginBottom: 28 }}>
          Displayed range vs. realized arrival time, by mode. Dataset: {observations.observations.length} redacted observations ({observations.collected}).
        </p>

        <section aria-label="displayed versus realized error" style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Displayed vs. realized error</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={head}>Mode</th>
                <th style={head}>Observations</th>
                <th style={head}>Mean |error|</th>
                <th style={head}>Mean range width</th>
                <th style={head}>Coverage</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((s) => (
                <tr key={s.mode} data-testid={`summary-${s.mode}`} style={{ background: s.mode === 'traffic' ? 'rgba(63,132,135,0.08)' : 'rgba(255,122,107,0.06)' }}>
                  <td style={cell}>{s.mode}{s.mode !== 'traffic' ? ' (degraded)' : ''}</td>
                  <td style={cell}>{s.count}</td>
                  <td style={cell}>{s.meanAbsErrorMin} min</td>
                  <td style={cell}>{s.meanRangeWidthMin} min</td>
                  <td style={cell}>{s.coveragePct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section aria-label="fitted constants">
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Fitted vs. legacy constants</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={head}>Constant</th>
                <th style={head}>Legacy</th>
                <th style={head}>Fitted (committed)</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(FITTED_ETA_CONSTANTS).map((key) => (
                <tr key={key}>
                  <td style={cell}>{key}</td>
                  <td style={{ ...cell, opacity: 0.6 }}>{legacy[key]}</td>
                  <td style={cell}>{fit[key]}</td>
                </tr>
              ))}
              <tr>
                <td style={cell}>runtime copy matches dataset</td>
                <td style={cell} colSpan={2}>
                  {Object.keys(FITTED_ETA_CONSTANTS).every((k) =>
                    (FITTED_ETA_CONSTANTS as unknown as Record<string, number>)[k] === fit[k],
                  ) ? 'yes' : 'NO — regenerate etaConstants.ts'}
                </td>
              </tr>
            </tbody>
          </table>
          <p style={{ fontSize: 12, opacity: 0.55, marginTop: 16 }}>
            Evidence and rationale: <code>data/eta-calibration/README.md</code> · ADR-022.
            Locally recorded outcomes ({loadCalibrationRecords().length}) are included above.
          </p>
        </section>
      </div>
    </main>
  )
}
