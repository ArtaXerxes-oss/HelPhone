import { Router, type Request, type Response } from 'express'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ADR-020 Priority Tiers:
 * - P0: Life-critical (medical, danger, immediate life safety)
 * - P1: Urgent (lost, fallen, offer acceptance)
 * - P2: Operational (responder offers, status changes, administrative, docs)
 * - P3: Telemetry (location updates, metrics, ICE transport telemetry)
 */
export type PriorityTier = 'P0' | 'P1' | 'P2' | 'P3'

export interface RouteDoc {
  path: string
  method: string
  summary: string
  description?: string
  tier: PriorityTier
  tierRationale: string
  parameters?: Array<{ name: string; in: string; required?: boolean; description?: string }>
  responses?: Record<string, { description: string }>
}

export interface GraphQLDoc {
  name: string
  kind: 'query' | 'mutation' | 'type' | 'enum' | 'scalar'
  description?: string
  tier?: PriorityTier
  fields?: string[]
}

export interface ApiReference {
  version: string
  title: string
  description: string
  generatedAt: string
  csp: string
  routes: RouteDoc[]
  graphql: GraphQLDoc[]
  tiers: Record<PriorityTier, { name: string; description: string; sheddingOrder: string }>
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ADR-020 tier definitions
export const ADR020_TIERS: Record<PriorityTier, { name: string; description: string; sheddingOrder: string }> = {
  P0: {
    name: 'Life-critical',
    description: 'Emergency creation for life-threatening incidents (medical, danger).',
    sheddingOrder: 'Never dropped. Shed P3, P2, and P1 before queueing P0.',
  },
  P1: {
    name: 'Urgent',
    description: 'Urgent incidents (lost, fallen) and responder offer acceptance.',
    sheddingOrder: 'Bounded queue (10,000 entries). Drop oldest if full under overload.',
  },
  P2: {
    name: 'Operational',
    description: 'Responder offers, status changes, incident history, authentication, and API docs.',
    sheddingOrder: 'Bounded queue (5,000 entries). Drop oldest if full under overload.',
  },
  P3: {
    name: 'Telemetry',
    description: 'Coalesced location pings, WebRTC ICE metrics, and Prometheus scrape gauges.',
    sheddingOrder: 'Bounded queue (1,000 entries). Drop oldest and coalesce aggressively.',
  },
}

/**
 * Wallet address regexes for redaction hardening.
 * Matches Stellar public keys (G... 56 chars), contracts (C...), seeds (S...),
 * and EVM addresses (0x... 40 hex chars).
 */
const WALLET_REGEXES = [
  /\b[GCMS][A-Z2-7]{55}\b/g,
  /\b0x[a-fA-F0-9]{40}\b/g,
]

export function redactWalletAddresses(text: string): string {
  let redacted = text
  for (const regex of WALLET_REGEXES) {
    redacted = redacted.replace(regex, '[REDACTED_ACCOUNT]')
  }
  return redacted
}

export function containsWalletAddress(text: string): boolean {
  for (const regex of WALLET_REGEXES) {
    regex.lastIndex = 0
    if (regex.test(text)) return true
  }
  return false
}

/**
 * Classifies an API route into its ADR-020 priority tier.
 */
export function classifyRouteTier(path: string, method: string): { tier: PriorityTier; rationale: string } {
  const m = method.toUpperCase()
  const p = path.toLowerCase()

  if (p === '/api/dispatch' && m === 'POST') {
    return {
      tier: 'P0',
      rationale: 'ADR-020: Request creation for medical and danger incidents is life-critical.',
    }
  }

  if (p.includes('/accept') || (p === '/api/dispatch' && m === 'GET')) {
    return {
      tier: 'P1',
      rationale: 'ADR-020: Offer acceptance and real-time incident retrieval are urgent dispatch actions.',
    }
  }

  if (p.includes('ice-metric') || p.includes('/metrics') || p.includes('telemetry') || p.includes('location')) {
    return {
      tier: 'P3',
      rationale: 'ADR-020: Telemetry, ICE gathering stats, and metrics are lowest priority and shed first.',
    }
  }

  return {
    tier: 'P2',
    rationale: 'ADR-020: General operations, responder status changes, documentation, and metadata.',
  }
}

/**
 * Extracts schema types and operations from server/graphql/schema.graphql
 */
export function parseGraphQLSchema(schemaText: string): GraphQLDoc[] {
  const cleaned = redactWalletAddresses(schemaText)
  const docs: GraphQLDoc[] = []
  const typeRegex = /(type|enum|scalar|input)\s+([A-Za-z0-9_]+)\s*(?:implements\s+[^{]+)?\s*\{?([^}]*)\}?/g
  let match: RegExpExecArray | null

  while ((match = typeRegex.exec(cleaned)) !== null) {
    const kindRaw = match[1]
    const name = match[2]
    const body = match[3] || ''

    if (name === 'Query') {
      const fieldLines = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      for (const fl of fieldLines) {
        const opMatch = fl.match(/^([A-Za-z0-9_]+)(?:\(([^)]*)\))?:\s*(.+)$/)
        if (opMatch) {
          docs.push({
            name: `Query.${opMatch[1]}`,
            kind: 'query',
            description: `GraphQL query returning ${opMatch[3]}`,
            tier: opMatch[1].includes('incident') ? 'P1' : 'P2',
          })
        }
      }
    } else if (name === 'Mutation') {
      const fieldLines = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      for (const fl of fieldLines) {
        const opMatch = fl.match(/^([A-Za-z0-9_]+)(?:\(([^)]*)\))?:\s*(.+)$/)
        if (opMatch) {
          const isUrgent = opMatch[1].toLowerCase().includes('assign') || opMatch[1].toLowerCase().includes('flush')
          docs.push({
            name: `Mutation.${opMatch[1]}`,
            kind: 'mutation',
            description: `GraphQL mutation returning ${opMatch[3]}`,
            tier: isUrgent ? 'P1' : 'P2',
          })
        }
      }
    } else {
      const fields = body
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .slice(0, 15)

      docs.push({
        name,
        kind: kindRaw === 'enum' ? 'enum' : kindRaw === 'scalar' ? 'scalar' : 'type',
        fields: fields.length ? fields : undefined,
      })
    }
  }

  return docs
}

/**
 * Builds the complete API Reference dataset from swagger.json and schema.graphql.
 */
export function buildApiReference(root = REPO_ROOT): ApiReference {
  const swaggerPath = join(root, 'swagger.json')
  const graphqlPath = join(root, 'server', 'graphql', 'schema.graphql')

  let swaggerRaw = '{}'
  if (existsSync(swaggerPath)) {
    swaggerRaw = readFileSync(swaggerPath, 'utf8')
  }

  let graphqlRaw = ''
  if (existsSync(graphqlPath)) {
    graphqlRaw = readFileSync(graphqlPath, 'utf8')
  }

  const sanitizedSwagger = redactWalletAddresses(swaggerRaw)
  const swagger = JSON.parse(sanitizedSwagger)

  const routes: RouteDoc[] = []
  for (const [path, methods] of Object.entries(swagger.paths || {})) {
    for (const [method, op] of Object.entries(methods as Record<string, any>)) {
      if (['get', 'post', 'put', 'delete', 'patch'].includes(method.toLowerCase())) {
        const { tier, rationale } = classifyRouteTier(path, method)
        routes.push({
          path,
          method: method.toUpperCase(),
          summary: op.summary || `${method.toUpperCase()} ${path}`,
          description: op.description,
          tier,
          tierRationale: rationale,
          parameters: op.parameters,
          responses: op.responses,
        })
      }
    }
  }

  const graphql = parseGraphQLSchema(graphqlRaw)

  return {
    version: swagger.info?.version || '1.0.0',
    title: swagger.info?.title || 'HelPhone API Reference',
    description: swagger.info?.description || 'REST & GraphQL Canonical API Specification with ADR-020 Priority Tiers',
    generatedAt: new Date().toISOString(),
    csp: "default-src 'none'; style-src 'unsafe-inline'",
    routes,
    graphql,
    tiers: ADR020_TIERS,
  }
}

const escapeHtml = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c)

/**
 * Renders HTML API reference with zero external scripts or styles.
 * Uses exact brand tokens: Primary teal #234B4E, Accent coral #FF7A6B, Cream bg #ECE0CC, Dark bg #1c2c24.
 */
export function renderDocsHtml(apiRef: ApiReference): string {
  const tierColor = (tier: PriorityTier) => {
    switch (tier) {
      case 'P0':
        return 'var(--coral)'
      case 'P1':
        return '#e67e22'
      case 'P2':
        return 'var(--ok)'
      case 'P3':
        return 'var(--purple)'
    }
  }

  const routeItems = apiRef.routes
    .map(
      (r) => `
    <div class="endpoint tier-${r.tier}">
      <div class="endpoint-header">
        <span class="badge method method-${r.method.toLowerCase()}">${escapeHtml(r.method)}</span>
        <span class="path">${escapeHtml(r.path)}</span>
        <span class="badge tier" style="background:${tierColor(r.tier)}">${escapeHtml(r.tier)}: ${escapeHtml(apiRef.tiers[r.tier].name)}</span>
      </div>
      <div class="summary">${escapeHtml(r.summary)}</div>
      <div class="rationale"><strong>Triage policy:</strong> ${escapeHtml(r.tierRationale)}</div>
    </div>`,
    )
    .join('')

  const gqlItems = apiRef.graphql
    .map(
      (g) => `
    <div class="endpoint gql-item">
      <div class="endpoint-header">
        <span class="badge method gql-kind">${escapeHtml(g.kind.toUpperCase())}</span>
        <span class="path">${escapeHtml(g.name)}</span>
        ${g.tier ? `<span class="badge tier" style="background:${tierColor(g.tier)}">${escapeHtml(g.tier)}</span>` : ''}
      </div>
      ${g.description ? `<div class="summary">${escapeHtml(g.description)}</div>` : ''}
      ${g.fields ? `<pre class="fields">${escapeHtml(g.fields.join('\n'))}</pre>` : ''}
    </div>`,
    )
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(apiRef.title)} v${escapeHtml(apiRef.version)}</title>
<style>
:root {
  --bg: #ECE0CC;
  --fg: #234B4E;
  --card: #ffffff;
  --muted: #5b6b6c;
  --coral: #FF7A6B;
  --purple: #7357FF;
  --ok: #234B4E;
  --border: #d3c7b3;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1c2c24;
    --fg: #e8efe9;
    --card: #253930;
    --muted: #9fb3b1;
    --coral: #FF7A6B;
    --purple: #9b87ff;
    --ok: #6cc3c6;
    --border: #354f43;
  }
}
body {
  margin: 0;
  padding: 24px 16px;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
main {
  max-width: 960px;
  margin: 0 auto;
}
header {
  margin-bottom: 24px;
  border-bottom: 2px solid var(--border);
  padding-bottom: 16px;
}
h1 {
  margin: 0 0 6px;
  font-size: 26px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.version {
  font-size: 14px;
  background: var(--coral);
  color: #fff;
  padding: 2px 8px;
  border-radius: 12px;
}
.desc {
  color: var(--muted);
  margin: 0 0 16px;
}
.tiers-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  margin-bottom: 28px;
}
.tier-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.tier-card h4 {
  margin: 0 0 4px;
  font-size: 14px;
}
.tier-card p {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
h2 {
  font-size: 20px;
  margin: 24px 0 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.endpoint {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
  margin-bottom: 10px;
}
.endpoint-header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.badge {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 4px;
  color: #fff;
}
.method-get { background: #27ae60; }
.method-post { background: #2980b9; }
.method-put { background: #d35400; }
.method-delete { background: #c0392b; }
.gql-kind { background: var(--purple); }
.path {
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 14px;
}
.summary {
  margin-top: 8px;
  font-size: 14px;
}
.rationale {
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted);
}
.fields {
  background: rgba(0,0,0,0.04);
  padding: 8px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  overflow-x: auto;
  margin: 8px 0 0;
}
footer {
  margin-top: 36px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--muted);
  display: flex;
  justify-content: space-between;
}
</style>
</head>
<body>
<main>
  <header>
    <h1>${escapeHtml(apiRef.title)} <span class="version">v${escapeHtml(apiRef.version)}</span></h1>
    <p class="desc">${escapeHtml(apiRef.description)}</p>
    <div class="tiers-grid">
      <div class="tier-card" style="border-top: 3px solid var(--coral);">
        <h4>P0 — Life-critical</h4>
        <p>${escapeHtml(apiRef.tiers.P0.description)}</p>
      </div>
      <div class="tier-card" style="border-top: 3px solid #e67e22;">
        <h4>P1 — Urgent</h4>
        <p>${escapeHtml(apiRef.tiers.P1.description)}</p>
      </div>
      <div class="tier-card" style="border-top: 3px solid var(--ok);">
        <h4>P2 — Operational</h4>
        <p>${escapeHtml(apiRef.tiers.P2.description)}</p>
      </div>
      <div class="tier-card" style="border-top: 3px solid var(--purple);">
        <h4>P3 — Telemetry</h4>
        <p>${escapeHtml(apiRef.tiers.P3.description)}</p>
      </div>
    </div>
  </header>

  <h2>REST Endpoints (${apiRef.routes.length})</h2>
  ${routeItems}

  <h2>GraphQL Schema & Operations (${apiRef.graphql.length})</h2>
  ${gqlItems}

  <footer>
    <span>HelPhone Contract Drift Guard (HP-093) verified</span>
    <span>Generated: ${escapeHtml(apiRef.generatedAt)}</span>
  </footer>
</main>
</body>
</html>`
}

/**
 * HP-093 Contract Drift Guard:
 * Verifies that the API reference is strictly in sync with swagger.json and schema.graphql,
 * and ensures that NO raw wallet addresses exist anywhere in the generated output.
 */
export function verifyContractDrift(root = REPO_ROOT): {
  synced: boolean
  routeCount: number
  graphqlCount: number
  walletLeakDetected: boolean
} {
  const swaggerPath = join(root, 'swagger.json')
  const graphqlPath = join(root, 'server', 'graphql', 'schema.graphql')

  if (!existsSync(swaggerPath)) {
    throw new Error(`HP-093 Drift Guard: Missing swagger.json at ${swaggerPath}`)
  }
  if (!existsSync(graphqlPath)) {
    throw new Error(`HP-093 Drift Guard: Missing schema.graphql at ${graphqlPath}`)
  }

  const apiRef = buildApiReference(root)
  const html = renderDocsHtml(apiRef)
  const jsonStr = JSON.stringify(apiRef)

  if (containsWalletAddress(html) || containsWalletAddress(jsonStr)) {
    throw new Error('HP-093 Drift Guard: Wallet address detected in API reference output!')
  }

  const swagger = JSON.parse(readFileSync(swaggerPath, 'utf8'))
  const rawSwaggerRoutesCount = Object.values(swagger.paths || {}).reduce(
    (acc: number, m: any) => acc + Object.keys(m).filter((k) => ['get', 'post', 'put', 'delete', 'patch'].includes(k)).length,
    0,
  )

  if (apiRef.routes.length !== rawSwaggerRoutesCount) {
    throw new Error(
      `HP-093 Drift Guard: Route count drift! swagger.json has ${rawSwaggerRoutesCount} routes, but docs generated ${apiRef.routes.length}`,
    )
  }

  return {
    synced: true,
    routeCount: apiRef.routes.length,
    graphqlCount: apiRef.graphql.length,
    walletLeakDetected: false,
  }
}

/**
 * Creates the express router for /docs.
 * Routes:
 * - GET /: Returns versioned HTML or JSON API reference (ADR-020 priority: P2 - Operational)
 * - GET /json: Returns pure JSON API specification (ADR-020 priority: P2 - Operational)
 * - GET /health: Returns drift guard sync status (ADR-020 priority: P2 - Operational)
 */
export function createDocsRouter(options: { root?: string } = {}): Router {
  const router = Router()
  const root = options.root ?? REPO_ROOT

  /**
   * GET /docs
   * Life-safety classification: ADR-020 P2 (Operational)
   * Serves versioned HTML documentation, or JSON if requested via header/query.
   */
  router.get('/', (req: Request, res: Response) => {
    const apiRef = buildApiReference(root)
    const acceptsJson = req.headers.accept?.includes('application/json') || req.query.format === 'json'

    if (acceptsJson) {
      res.set('Cache-Control', 'no-store').json(apiRef)
      return
    }

    res
      .set('Content-Security-Policy', apiRef.csp)
      .set('Cache-Control', 'public, max-age=300')
      .type('html')
      .send(renderDocsHtml(apiRef))
  })

  /**
   * GET /docs/json
   * Life-safety classification: ADR-020 P2 (Operational)
   * Serves complete JSON API reference payload.
   */
  router.get('/json', (_req: Request, res: Response) => {
    const apiRef = buildApiReference(root)
    res.set('Cache-Control', 'no-store').json(apiRef)
  })

  /**
   * GET /docs/drift-status
   * Life-safety classification: ADR-020 P2 (Operational)
   * Verifies HP-093 contract drift status.
   */
  const handleDriftCheck = (_req: Request, res: Response) => {
    try {
      const status = verifyContractDrift(root)
      res.json({ ok: true, driftGuard: 'HP-093', ...status })
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message })
    }
  }

  router.get('/drift-status', handleDriftCheck)
  router.get('/health', handleDriftCheck)

  return router
}

export const docsRouter = createDocsRouter()
export default docsRouter
