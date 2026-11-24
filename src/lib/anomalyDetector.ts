/**
 * Anomaly detection with alert grouping and deploy/flag correlation (#773 / ISP-103).
 *
 * Replaces naive "p95 > 800ms for 2 minutes → page" with:
 * - burst-aware baselines
 * - deploy / feature-flag markers that suppress false pages
 * - causal-chain aware sampling (keep retry spans under one trace)
 * - alert grouping so one burst → one incident
 */

export type MarkerKind = 'deploy' | 'flag_flip' | 'burst'

export interface TelemetrySpan {
  traceId: string
  spanId: string
  name: string
  durationMs: number
  status: 'ok' | 'error'
  at: number
  parentSpanId?: string
}

export interface TimelineMarker {
  kind: MarkerKind
  at: number
  label: string
}

export interface AnomalyAlert {
  id: string
  reason: string
  severity: 'info' | 'warning' | 'critical'
  startedAt: number
  endedAt: number
  spanCount: number
  correlatedMarkers: string[]
  grouped: boolean
}

export interface DetectorConfig {
  /** Absolute p95 latency that can page outside a marker window. */
  p95ThresholdMs?: number
  /** Ignore latency spikes within this many ms of a deploy/flag marker. */
  markerGraceMs?: number
  /** Group alerts that start within this window. */
  groupWindowMs?: number
  /** Keep at least this fraction of spans that share a stalled trace. */
  causalKeepRatio?: number
  /** Head sample ratio for healthy ok spans. */
  headSampleRatio?: number
}

const DEFAULTS: Required<DetectorConfig> = {
  p95ThresholdMs: 800,
  markerGraceMs: 5 * 60 * 1000,
  groupWindowMs: 2 * 60 * 1000,
  causalKeepRatio: 0.95,
  headSampleRatio: 0.1,
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

export function isInsideMarkerWindow(
  at: number,
  markers: TimelineMarker[],
  graceMs: number,
): TimelineMarker | null {
  for (const marker of markers) {
    if (Math.abs(at - marker.at) <= graceMs) return marker
  }
  return null
}

/**
 * Tail-aware sampler: always keep error spans and long causal chains;
 * head-sample the rest.
 */
export function sampleSpans(
  spans: TelemetrySpan[],
  config: DetectorConfig = {},
  random: () => number = Math.random,
): TelemetrySpan[] {
  const opts = { ...DEFAULTS, ...config }
  const byTrace = new Map<string, TelemetrySpan[]>()
  for (const span of spans) {
    const list = byTrace.get(span.traceId) ?? []
    list.push(span)
    byTrace.set(span.traceId, list)
  }

  const kept: TelemetrySpan[] = []
  for (const [, traceSpans] of byTrace) {
    const totalDuration = traceSpans.reduce((s, x) => s + x.durationMs, 0)
    const hasError = traceSpans.some((s) => s.status === 'error')
    const isStall = totalDuration >= opts.p95ThresholdMs * 2 || traceSpans.length >= 4
    if (hasError || isStall) {
      // Preserve the causal chain.
      const keepCount = Math.max(1, Math.ceil(traceSpans.length * opts.causalKeepRatio))
      kept.push(...traceSpans.slice(0, keepCount))
      continue
    }
    for (const span of traceSpans) {
      if (random() <= opts.headSampleRatio) kept.push(span)
    }
  }
  return kept
}

export function detectAnomalies(
  spans: TelemetrySpan[],
  markers: TimelineMarker[] = [],
  config: DetectorConfig = {},
): AnomalyAlert[] {
  const opts = { ...DEFAULTS, ...config }
  if (!spans.length) return []

  const durations = spans.map((s) => s.durationMs)
  const p95 = percentile(durations, 95)
  if (p95 < opts.p95ThresholdMs) return []

  const windowStart = Math.min(...spans.map((s) => s.at))
  const windowEnd = Math.max(...spans.map((s) => s.at))
  const correlated = markers
    .filter((m) => m.at >= windowStart - opts.markerGraceMs && m.at <= windowEnd + opts.markerGraceMs)
    .map((m) => m.label)

  // Deploy / flag flips inside the grace window are not pages.
  if (correlated.some((label) => label.startsWith('deploy:') || label.startsWith('flag:'))) {
    return [
      {
        id: `suppressed-${windowStart}`,
        reason: 'latency shift correlated with deploy/flag marker',
        severity: 'info',
        startedAt: windowStart,
        endedAt: windowEnd,
        spanCount: spans.length,
        correlatedMarkers: correlated,
        grouped: true,
      },
    ]
  }

  const severity: AnomalyAlert['severity'] =
    p95 >= opts.p95ThresholdMs * 3 ? 'critical' : 'warning'

  return [
    {
      id: `incident-${windowStart}`,
      reason: `dispatch p95 ${Math.round(p95)}ms over ${opts.p95ThresholdMs}ms`,
      severity,
      startedAt: windowStart,
      endedAt: windowEnd,
      spanCount: spans.length,
      correlatedMarkers: correlated,
      grouped: true,
    },
  ]
}

/** Collapse raw threshold fires into one banner per burst. */
export function groupAlerts(alerts: AnomalyAlert[], groupWindowMs = DEFAULTS.groupWindowMs): AnomalyAlert[] {
  if (!alerts.length) return []
  const sorted = [...alerts].sort((a, b) => a.startedAt - b.startedAt)
  const groups: AnomalyAlert[] = []
  let current = { ...sorted[0], grouped: true }

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]
    if (next.startedAt - current.endedAt <= groupWindowMs) {
      current = {
        ...current,
        endedAt: Math.max(current.endedAt, next.endedAt),
        spanCount: current.spanCount + next.spanCount,
        correlatedMarkers: [...new Set([...current.correlatedMarkers, ...next.correlatedMarkers])],
        severity:
          current.severity === 'critical' || next.severity === 'critical'
            ? 'critical'
            : current.severity === 'warning' || next.severity === 'warning'
              ? 'warning'
              : 'info',
        reason: current.reason,
        grouped: true,
      }
    } else {
      groups.push(current)
      current = { ...next, grouped: true }
    }
  }
  groups.push(current)
  return groups
}
