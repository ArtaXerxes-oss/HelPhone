import type { RequestHandler } from 'express'
import { readFileSync } from 'node:fs'

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
  suffix?: 'bucket' | 'sum' | 'count'
}

export interface MetricFamily {
  name: string
  help: string
  type: 'gauge' | 'counter' | 'histogram'
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
      lines.push(`${f.name}${s.suffix ? `_${s.suffix}` : ''}${labelStr} ${formatValue(s.value)}`)
    }
  }
  return lines.join('\n') + '\n'
}

// ── HTTP request counters ─────────────────────────────────────────────────────
// Scoped per process; under the cluster in server/index.js each worker reports
// its own counts, which Prometheus sums across scrape targets.

const requestCounts = new Map<string, number>()
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
const durations = new Map<string, { labels: Labels; count: number; sum: number; bounds: number[]; buckets: number[] }>()

/**
 * Budget-aligned buckets shared with RUM/synthetic ingest (#795, #796): read
 * from perf-budget.json so a link's budget is a bucket boundary and p95s are
 * comparable across pipes. Falls back to HTTP_BUCKETS if the file is absent.
 */
export const BUDGET_BUCKETS: number[] = (() => {
  try {
    const budget = JSON.parse(readFileSync(new URL('../../perf-budget.json', import.meta.url), 'utf8'))
    return Array.isArray(budget.histogramBucketsSeconds) ? budget.histogramBucketsSeconds : HTTP_BUCKETS
  } catch {
    return HTTP_BUCKETS
  }
})()

/** Per-link server timings: ws.queue, pg.pool.wait, redis.publish, parser.decode, indexer.lag. */
export type BudgetLink = 'ws.queue' | 'pg.pool.wait' | 'redis.publish' | 'parser.decode' | 'indexer.lag'

export function observeLink(link: BudgetLink, seconds: number): void {
  observeDuration('helphone_link_duration_seconds', 'Per-link duration in seconds (perf-budget.json buckets).', { link }, seconds, BUDGET_BUCKETS)
}

export function observeDuration(name: string, help: string, labels: Labels, seconds: number, bounds: number[] = HTTP_BUCKETS): void {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name) || !Number.isFinite(seconds) || seconds < 0) return
  const key = `${name}\u0000${Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join('\u0000')}`
  const entry = durations.get(key) ?? { labels, count: 0, sum: 0, bounds, buckets: Array(bounds.length).fill(0) }
  entry.count += 1
  entry.sum += seconds
  const bucket = entry.bounds.findIndex((bound) => seconds <= bound)
  if (bucket >= 0) entry.buckets[bucket] += 1
  durations.set(key, entry)
}

export const requestMetrics: RequestHandler = (req, res, next) => {
  const startedAt = process.hrtime.bigint()
  res.on('finish', () => {
    // Route template when Express matched one, never the raw URL — raw paths
    // carry addresses/ids and would explode label cardinality.
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched'
    const key = `${req.method}\u0000${route}\u0000${res.statusCode}`
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1)
    observeDuration('helphone_http_request_duration_seconds', 'HTTP request duration in seconds.', {
      method: req.method,
      route,
      status: String(res.statusCode),
    }, Number(process.hrtime.bigint() - startedAt) / 1e9)
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

export function durationFamilies(): MetricFamily[] {
  const families = new Map<string, MetricFamily>()
  for (const [key, entry] of durations) {
    const name = key.split('\u0000', 1)[0]
    let family = families.get(name)
    if (!family) {
      family = { name, help: 'Observed operation durations in seconds.', type: 'histogram', samples: [] }
      families.set(name, family)
    }
    let cumulative = 0
    entry.bounds.forEach((bound, index) => {
      cumulative += entry.buckets[index]
      family!.samples.push({ labels: { ...entry.labels, le: String(bound) }, value: cumulative, suffix: 'bucket' })
    })
    family.samples.push({ labels: { ...entry.labels, le: '+Inf' }, value: entry.count, suffix: 'bucket' })
    family.samples.push({ labels: entry.labels, value: entry.sum, suffix: 'sum' })
    family.samples.push({ labels: entry.labels, value: entry.count, suffix: 'count' })
  }
  return [...families.values()]
}

export async function measureLink<T>(link: BudgetLink, operation: () => Promise<T>): Promise<T> {
  const startedAt = process.hrtime.bigint()
  try {
    return await operation()
  } finally {
    observeLink(link, Number(process.hrtime.bigint() - startedAt) / 1e9)
  }
}

export async function measureDuration<T>(name: string, labels: Labels, operation: () => Promise<T>): Promise<T> {
  const startedAt = process.hrtime.bigint()
  try {
    return await operation()
  } finally {
    observeDuration(name, 'Observed operation durations in seconds.', labels, Number(process.hrtime.bigint() - startedAt) / 1e9)
  }
}

export function resetRequestMetrics(): void {
  requestCounts.clear()
  durations.clear()
}
