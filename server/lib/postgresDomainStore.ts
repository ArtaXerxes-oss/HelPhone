import { DomainStore, type DomainEvent, type Incident, type Responder } from './domainStore.ts'

export interface PgQuery {
  (sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

/** Load the canonical projection in three bounded queries, always scoped by tenant. */
export async function loadPostgresDomainStore(query: PgQuery, tenantId: string): Promise<DomainStore> {
  if (!tenantId.trim()) throw new Error('tenantId is required for the postgres domain store')
  const [incidents, responders, events] = await Promise.all([
    query('SELECT id, status, priority, created_at AS "createdAt", version, location FROM incidents WHERE tenant_id = $1', [tenantId]),
    query('SELECT id, incident_id AS "incidentId", name, status, location FROM responders WHERE tenant_id = $1', [tenantId]),
    query('SELECT id, incident_id AS "incidentId", responder_id AS "responderId", type, at, cursor, payload FROM domain_events WHERE tenant_id = $1 ORDER BY cursor', [tenantId]),
  ])
  const store = new DomainStore({ seed: false })
  store.loadSnapshot({
    incidents: incidents.rows as unknown as Incident[],
    responders: responders.rows as unknown as Responder[],
    events: events.rows as unknown as DomainEvent[],
  })
  return store
}

export async function loadConfiguredDomainStore(
  query: PgQuery,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DomainStore> {
  if (env.DOMAIN_STORE !== 'postgres') return new DomainStore()
  return loadPostgresDomainStore(query, env.TENANT_ID ?? '')
}
