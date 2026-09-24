import type { RequestHandler } from 'express'

/**
 * Minimal Prometheus text-exposition support (format 0.0.4), node built-ins only.
 *
 * Deliberately not prom-client: the security metrics (#600) are a handful of
 * gauges recomputed from disk, and adding a dependency to a supply-chain
 * endpoint would itself widen the supply chain it reports on.
 */

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

export type Labels = Record<string, string>

export interface MetricSample {
  labels?: Labels
  value: number
}

export interface MetricFamily {
  name: string
  help: string
  type: 'gauge' | 'counter'
  samples: MetricSample[]
}

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function escapeHelp(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
}

function formatValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN'
  if (v === Infinity) return '+Inf'
  if (v === -Infinity) return '-Inf'
  return String(v)
}

/** Serialises metric families to the Prometheus text exposition format. */
export function renderPrometheus(families: MetricFamily[]): string {
  const lines: string[] = []
  for (const f of families) {
    if (!NAME_RE.test(f.name)) throw new Error(`Invalid metric name: ${f.name}`)
    lines.push(`# HELP ${f.name} ${escapeHelp(f.help)}`)
    lines.push(`# TYPE ${f.name} ${f.type}`)
    for (const s of f.samples) {
      const labels = Object.entries(s.labels ?? {})
      const labelStr = labels.length
        ? `{${labels.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`
        : ''
      lines.push(`${f.name}${labelStr} ${formatValue(s.value)}`)
    }
  }
  return lines.join('\n') + '\n'
}

// ── HTTP request counters ─────────────────────────────────────────────────────
// Scoped per process; under the cluster in server/index.js each worker reports
// its own counts, which Prometheus sums across scrape targets.

const requestCounts = new Map<string, number>()

export const requestMetrics: RequestHandler = (req, res, next) => {
  res.on('finish', () => {
    // Route template when Express matched one, never the raw URL — raw paths
    // carry addresses/ids and would explode label cardinality.
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched'
    const key = `${req.method}\u0000${route}\u0000${res.statusCode}`
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1)
  })
  next()
}

export function httpRequestFamily(): MetricFamily {
  return {
    name: 'helphone_http_requests_total',
    help: 'HTTP requests handled by this worker, by method, route template and status.',
    type: 'counter',
    samples: [...requestCounts].map(([key, value]) => {
      const [method, route, status] = key.split('\u0000')
      return { labels: { method, route, status }, value }
    }),
  }
}

export function resetRequestMetrics(): void {
  requestCounts.clear()
}
