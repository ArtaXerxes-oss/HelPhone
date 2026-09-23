import { Router } from 'express'
import type { Request, Response } from 'express'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXCEPTIONS, classify } from '../../scripts/security/license_policy.js'
import {
  PROMETHEUS_CONTENT_TYPE,
  httpRequestFamily,
  renderPrometheus,
} from '../middleware/metrics.ts'
import type { MetricFamily } from '../middleware/metrics.ts'

/**
 * Supply Chain Security Index & Sustainability API (#600).
 *
 *   GET /api/supply-chain            JSON report (index, lockfile, CVEs, licenses, sustainability)
 *   GET /api/supply-chain/dashboard  executive HTML dashboard
 *   GET /metrics/security            Prometheus gauges for the same report
 *
 * Everything is derived from files already on disk: package-lock.json and an
 * `npm audit --json` report produced at build time (see render.yaml). The
 * request path never shells out to npm or reaches the network — an endpoint
 * that could be made to run `npm audit` on demand would be a DoS lever.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_TTL_MS = 60_000

export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical'
const SEVERITIES: Severity[] = ['info', 'low', 'moderate', 'high', 'critical']

export interface SupplyChainReport {
  generatedAt: string
  index: { score: number; grade: string; partial: boolean; components: Record<string, number | null> }
  lockfile: {
    present: boolean
    lockfileVersion: number | null
    sha256: string | null
    packages: number
    withIntegrity: number
    integrityCoverage: number
    nonRegistrySources: string[]
    weakIntegrity: number
  }
  vulnerabilities: {
    source: 'npm-audit' | 'unavailable'
    reportAgeSeconds: number | null
    counts: Record<Severity | 'total', number> | null
  }
  licenses: {
    total: number
    approved: number
    review: number
    denied: number
    excepted: number
    complianceScore: number
    deniedPackages: string[]
  }
  sustainability: {
    directDependencies: number
    transitiveDependencies: number
    deprecated: string[]
    fundingDeclared: number
    fundingCoverage: number
  }
}

export interface ReportOptions {
  root?: string
  auditReportPath?: string
  now?: number
}

interface LockEntry {
  version?: string
  resolved?: string
  integrity?: string
  license?: string
  deprecated?: string
  funding?: unknown
  dev?: boolean
  link?: boolean
}

const round1 = (n: number) => Math.round(n * 10) / 10
const pct = (part: number, whole: number) => (whole === 0 ? 100 : round1((part / whole) * 100))

function readLockfile(root: string) {
  const path = join(root, 'package-lock.json')
  if (!existsSync(path)) return null
  const raw = readFileSync(path)
  const json = JSON.parse(raw.toString('utf8')) as {
    lockfileVersion?: number
    packages?: Record<string, LockEntry>
  }
  return { raw, json }
}

function lockfileSection(lock: ReturnType<typeof readLockfile>): SupplyChainReport['lockfile'] {
  if (!lock) {
    return {
      present: false, lockfileVersion: null, sha256: null, packages: 0,
      withIntegrity: 0, integrityCoverage: 0, nonRegistrySources: [], weakIntegrity: 0,
    }
  }
  let packages = 0
  let withIntegrity = 0
  let weakIntegrity = 0
  const nonRegistrySources: string[] = []
  for (const [path, meta] of Object.entries(lock.json.packages ?? {})) {
    // Root entry and workspace symlinks are source-controlled, not fetched.
    if (!path || meta.link) continue
    packages++
    if (meta.integrity) {
      withIntegrity++
      // sha1 subresource hashes are collision-prone; npm only emits them for
      // very old publishes.
      if (!/(^|\s)sha(384|512)-/.test(meta.integrity)) weakIntegrity++
    }
    if (meta.resolved && !meta.resolved.startsWith('https://registry.npmjs.org/')) {
      nonRegistrySources.push(`${path.replace(/^.*node_modules\//, '')} <- ${meta.resolved}`)
    }
  }
  return {
    present: true,
    lockfileVersion: lock.json.lockfileVersion ?? null,
    sha256: createHash('sha256').update(lock.raw).digest('hex'),
    packages,
    withIntegrity,
    integrityCoverage: pct(withIntegrity, packages),
    nonRegistrySources,
    weakIntegrity,
  }
}

function vulnerabilitySection(auditPath: string, now: number): SupplyChainReport['vulnerabilities'] {
  if (!existsSync(auditPath)) return { source: 'unavailable', reportAgeSeconds: null, counts: null }
  try {
    const audit = JSON.parse(readFileSync(auditPath, 'utf8')) as {
      metadata?: { vulnerabilities?: Partial<Record<Severity | 'total', number>> }
    }
    const v = audit.metadata?.vulnerabilities
    if (!v) return { source: 'unavailable', reportAgeSeconds: null, counts: null }
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, Number(v[s] ?? 0)])) as Record<Severity | 'total', number>
    counts.total = Number(v.total ?? SEVERITIES.reduce((a, s) => a + counts[s], 0))
    return {
      source: 'npm-audit',
      reportAgeSeconds: Math.max(0, Math.round((now - statSync(auditPath).mtimeMs) / 1000)),
      counts,
    }
  } catch {
    // A truncated/invalid report must not take the endpoint down; surface it
    // as missing so the index is flagged partial rather than silently green.
    return { source: 'unavailable', reportAgeSeconds: null, counts: null }
  }
}

function licenseSection(root: string, lock: ReturnType<typeof readLockfile>): SupplyChainReport['licenses'] {
  let approved = 0, review = 0, denied = 0, excepted = 0
  const deniedPackages: string[] = []
  for (const [path, meta] of Object.entries(lock?.json.packages ?? {})) {
    if (!path || meta.link) continue
    let license = meta.license
    if (!license) {
      try {
        const pkg = JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8'))
        license = pkg.license
      } catch {
        license = undefined
      }
    }
    const status = classify(license)
    if (status === 'approved') approved++
    else if (status === 'denied' && (EXCEPTIONS as Record<string, string>)[path]) excepted++
    else if (status === 'denied') {
      denied++
      deniedPackages.push(`${path.replace(/^.*node_modules\//, '')}@${meta.version ?? '?'} (${license})`)
    } else review++
  }
  const total = approved + review + denied + excepted
  return {
    total, approved, review, denied, excepted,
    complianceScore: pct(approved, total),
    deniedPackages,
  }
}

function sustainabilitySection(root: string, lock: ReturnType<typeof readLockfile>): SupplyChainReport['sustainability'] {
  let direct = 0
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    direct = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length
  } catch {
    // Missing manifest → zero direct deps reported.
  }
  let total = 0, fundingDeclared = 0
  const deprecated: string[] = []
  for (const [path, meta] of Object.entries(lock?.json.packages ?? {})) {
    if (!path || meta.link) continue
    total++
    if (meta.funding) fundingDeclared++
    if (meta.deprecated) deprecated.push(`${path.replace(/^.*node_modules\//, '')}@${meta.version ?? '?'}`)
  }
  return {
    directDependencies: direct,
    transitiveDependencies: Math.max(0, total - direct),
    deprecated,
    fundingDeclared,
    fundingCoverage: pct(fundingDeclared, total),
  }
}

/**
 * CVE component score: starts at 100 and loses points per open advisory,
 * weighted so a single critical outweighs a pile of low-severity noise.
 */
export function vulnerabilityScore(counts: Record<Severity | 'total', number>): number {
  const penalty = counts.critical * 40 + counts.high * 15 + counts.moderate * 4 + counts.low
  return Math.max(0, 100 - penalty)
}

export function grade(score: number): string {
  if (score >= 90) return 'A'
  if (score >= 80) return 'B'
  if (score >= 70) return 'C'
  if (score >= 60) return 'D'
  return 'F'
}

// Weights for the composite index. When the audit report is missing, the CVE
// weight is redistributed and the index is marked `partial` — never scored as
// if there were zero vulnerabilities.
const WEIGHTS = { vulnerabilities: 0.4, lockfileIntegrity: 0.3, licenseCompliance: 0.2, sustainability: 0.1 }

export function computeSupplyChainReport(opts: ReportOptions = {}): SupplyChainReport {
  const root = opts.root ?? REPO_ROOT
  const now = opts.now ?? Date.now()
  const auditPath = opts.auditReportPath
    ? (isAbsolute(opts.auditReportPath) ? opts.auditReportPath : join(root, opts.auditReportPath))
    : join(root, 'security-audit.json')

  const lock = readLockfile(root)
  const lockfile = lockfileSection(lock)
  const vulnerabilities = vulnerabilitySection(auditPath, now)
  const licenses = licenseSection(root, lock)
  const sustainability = sustainabilitySection(root, lock)

  // No lockfile means installs are not reproducible at all: integrity is 0.
  const lockScore = lockfile.present
    ? Math.max(0, lockfile.integrityCoverage - lockfile.nonRegistrySources.length * 5 - lockfile.weakIntegrity)
    : 0
  const licenseScore = licenses.denied > 0 ? 0 : licenses.complianceScore
  const deprecatedRatio = lockfile.packages ? sustainability.deprecated.length / lockfile.packages : 0
  const sustainabilityScore = round1(Math.max(0, 100 - deprecatedRatio * 1000))
  const vulnScore = vulnerabilities.counts ? vulnerabilityScore(vulnerabilities.counts) : null

  const components: Record<string, number | null> = {
    vulnerabilities: vulnScore,
    lockfileIntegrity: round1(lockScore),
    licenseCompliance: licenseScore,
    sustainability: sustainabilityScore,
  }
  let weighted = 0, weightSum = 0
  for (const [key, w] of Object.entries(WEIGHTS)) {
    const v = components[key]
    if (v == null) continue
    weighted += v * w
    weightSum += w
  }
  const score = weightSum ? round1(weighted / weightSum) : 0

  return {
    generatedAt: new Date(now).toISOString(),
    index: { score, grade: grade(score), partial: vulnScore == null, components },
    lockfile,
    vulnerabilities,
    licenses,
    sustainability,
  }
}

export function securityMetricFamilies(r: SupplyChainReport): MetricFamily[] {
  const gauge = (name: string, help: string, value: number, labels?: Record<string, string>): MetricFamily => ({
    name, help, type: 'gauge', samples: [{ value, labels }],
  })
  const families: MetricFamily[] = [
    gauge('helphone_supply_chain_security_index', 'Composite supply chain security index (0-100).', r.index.score),
    gauge('helphone_supply_chain_index_partial', '1 when the index was computed without a CVE audit report.', r.index.partial ? 1 : 0),
    gauge('helphone_lockfile_present', '1 when package-lock.json exists.', r.lockfile.present ? 1 : 0),
    gauge('helphone_lockfile_packages', 'Packages resolved in package-lock.json.', r.lockfile.packages),
    gauge('helphone_lockfile_integrity_coverage_percent', 'Share of locked packages carrying a subresource integrity hash.', r.lockfile.integrityCoverage),
    gauge('helphone_lockfile_non_registry_sources', 'Locked packages resolved from outside registry.npmjs.org.', r.lockfile.nonRegistrySources.length),
    gauge('helphone_license_compliance_score', 'Percent of dependencies on an approved license (#625 matrix).', r.licenses.complianceScore),
    {
      name: 'helphone_dependency_licenses',
      help: 'Dependencies by license policy status.',
      type: 'gauge',
      samples: (['approved', 'review', 'denied', 'excepted'] as const).map((status) => ({
        labels: { status }, value: r.licenses[status],
      })),
    },
    gauge('helphone_dependencies_deprecated', 'Locked packages flagged deprecated by their maintainers.', r.sustainability.deprecated.length),
    gauge('helphone_dependencies_funding_coverage_percent', 'Share of locked packages declaring a funding source.', r.sustainability.fundingCoverage),
  ]
  if (r.vulnerabilities.counts) {
    const counts = r.vulnerabilities.counts
    families.push({
      name: 'helphone_dependency_vulnerabilities',
      help: 'Open npm audit advisories by severity.',
      type: 'gauge',
      samples: SEVERITIES.map((severity) => ({ labels: { severity }, value: counts[severity] })),
    })
    families.push(gauge('helphone_audit_report_age_seconds', 'Age of the npm audit report backing the CVE counts.', r.vulnerabilities.reportAgeSeconds ?? 0))
  }
  return families
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function renderDashboard(r: SupplyChainReport): string {
  const tile = (label: string, value: string, note = '') =>
    `<div class="tile"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div>${note ? `<div class="note">${escapeHtml(note)}</div>` : ''}</div>`
  const v = r.vulnerabilities.counts
  const list = (title: string, items: string[]) =>
    items.length
      ? `<h2>${escapeHtml(title)} (${items.length})</h2><ul>${items.slice(0, 50).map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
      : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Supply Chain Security</title>
<style>
:root{--bg:#ECE0CC;--fg:#234B4E;--card:#fff;--muted:#5b6b6c;--bad:#c0392b;--ok:#3F8487}
@media (prefers-color-scheme:dark){:root{--bg:#10201f;--fg:#e8efe9;--card:#1b2f2e;--muted:#9fb3b1;--bad:#ff7a6b;--ok:#6cc3c6}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:24px 16px}
main{max-width:960px;margin:0 auto}h1{margin:0 0 4px}.sub{color:var(--muted);margin:0 0 24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.tile{background:var(--card);border-radius:10px;padding:14px}.label{color:var(--muted);font-size:13px}
.value{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums}.note{color:var(--muted);font-size:12px}
.grade-F,.grade-D{color:var(--bad)}.grade-A,.grade-B{color:var(--ok)}ul{padding-left:20px;word-break:break-all}
</style></head><body><main>
<h1>Supply Chain Security</h1>
<p class="sub">Generated ${escapeHtml(r.generatedAt)}${r.index.partial ? ' · partial: no npm audit report available' : ''}</p>
<div class="grid">
<div class="tile"><div class="label">Security index</div><div class="value grade-${r.index.grade}">${r.index.score} · ${r.index.grade}</div></div>
${tile('Critical / high CVEs', v ? `${v.critical} / ${v.high}` : 'n/a', v ? `${v.total} advisories total` : 'run npm audit --json')}
${tile('Lockfile integrity', `${r.lockfile.integrityCoverage}%`, `${r.lockfile.withIntegrity}/${r.lockfile.packages} hashed · v${r.lockfile.lockfileVersion ?? '?'}`)}
${tile('License compliance', `${r.licenses.complianceScore}%`, `${r.licenses.denied} denied · ${r.licenses.review} review · ${r.licenses.excepted} excepted`)}
${tile('Deprecated packages', String(r.sustainability.deprecated.length), `${r.sustainability.directDependencies} direct deps`)}
${tile('Funding declared', `${r.sustainability.fundingCoverage}%`, 'open-source sustainability')}
</div>
${list('Denied licenses', r.licenses.deniedPackages)}
${list('Non-registry sources', r.lockfile.nonRegistrySources)}
${list('Deprecated packages', r.sustainability.deprecated)}
</main></body></html>`
}

// ── Router ────────────────────────────────────────────────────────────────────

export interface RouterOptions extends ReportOptions {
  ttlMs?: number
}

export function createSupplyChainRouters(opts: RouterOptions = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const auditReportPath = opts.auditReportPath ?? process.env.SUPPLY_CHAIN_AUDIT_REPORT
  let cached: { at: number; report: SupplyChainReport } | null = null

  // package-lock.json is ~1k entries and each license lookup may hit disk, so
  // cache per worker; the inputs only change on deploy anyway.
  function report(): SupplyChainReport {
    const now = Date.now()
    if (!cached || now - cached.at >= ttlMs) {
      cached = { at: now, report: computeSupplyChainReport({ ...opts, auditReportPath }) }
    }
    return cached.report
  }

  const api = Router()
  api.get('/', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store').json(report())
  })
  api.get('/dashboard', (_req: Request, res: Response) => {
    res
      .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
      .type('html')
      .send(renderDashboard(report()))
  })

  const metrics = Router()
  metrics.get('/security', (_req: Request, res: Response) => {
    res
      .set('Content-Type', PROMETHEUS_CONTENT_TYPE)
      .send(renderPrometheus([...securityMetricFamilies(report()), httpRequestFamily()]))
  })

  return { api, metrics }
}
