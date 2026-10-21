import { describe, expect, it } from 'vitest'
import {
  detectAnomalies,
  groupAlerts,
  sampleSpans,
} from '../src/lib/anomalyDetector.ts'
import { burstLoadProfile } from '../src/utils/telemetryBench.js'

describe('ISP-103 anomaly detector (#773)', () => {
  it('preserves stalled causal chains while head-sampling healthy traces', () => {
    const spans = []
    for (let i = 0; i < 50; i++) {
      spans.push({
        traceId: `ok-${i}`,
        spanId: `s-${i}`,
        name: 'dispatch',
        durationMs: 100,
        status: 'ok',
        at: i,
      })
    }
    for (let i = 0; i < 5; i++) {
      spans.push({
        traceId: 'stall',
        spanId: `stall-${i}`,
        name: 'syncManager.retry',
        durationMs: 900,
        status: 'ok',
        at: 1000 + i,
        parentSpanId: i ? `stall-${i - 1}` : undefined,
      })
    }
    const kept = sampleSpans(spans, { headSampleRatio: 0.1, causalKeepRatio: 1 }, () => 0.99)
    const stallKept = kept.filter((s) => s.traceId === 'stall')
    expect(stallKept.length).toBe(5)
    expect(kept.length).toBeLessThan(spans.length)
  })

  it('suppresses pages that sit on a deploy/flag marker', () => {
    const now = 1_000_000
    const spans = Array.from({ length: 10 }, (_, i) => ({
      traceId: `t-${i}`,
      spanId: `s-${i}`,
      name: 'dispatch',
      durationMs: 2000,
      status: 'ok',
      at: now + i,
    }))
    const alerts = detectAnomalies(spans, [
      { kind: 'deploy', at: now, label: 'deploy:abc' },
    ])
    expect(alerts).toHaveLength(1)
    expect(alerts[0].severity).toBe('info')
    expect(alerts[0].id.startsWith('suppressed-')).toBe(true)
  })

  it('groups a burst into a single incident banner', () => {
    const base = 5_000_000
    const raw = [
      {
        id: 'a',
        reason: 'p95',
        severity: 'warning',
        startedAt: base,
        endedAt: base + 1000,
        spanCount: 3,
        correlatedMarkers: [],
        grouped: false,
      },
      {
        id: 'b',
        reason: 'p95',
        severity: 'warning',
        startedAt: base + 30_000,
        endedAt: base + 40_000,
        spanCount: 4,
        correlatedMarkers: [],
        grouped: false,
      },
      {
        id: 'c',
        reason: 'p95',
        severity: 'critical',
        startedAt: base + 50_000,
        endedAt: base + 60_000,
        spanCount: 2,
        correlatedMarkers: [],
        grouped: false,
      },
    ]
    const grouped = groupAlerts(raw, 120_000)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].severity).toBe('critical')
    expect(grouped[0].spanCount).toBe(9)
  })

  it('exposes a burst load profile for bench tuning', () => {
    const profile = burstLoadProfile({ baselineRate: 200, peakRate: 5000, seconds: 30 })
    expect(profile).toHaveLength(30)
    expect(Math.max(...profile.map((p) => p.rate))).toBe(5000)
    expect(profile[0].rate).toBe(200)
  })
})
