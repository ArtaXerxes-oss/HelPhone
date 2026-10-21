/**
 * server/graphql/resolvers.ts — resolvers and per-request DataLoaders
 *
 * Combines:
 * 1. Postgres-backed resolvers and DataLoaders (Issue #528)
 * 2. Domain incidents, events, responders, and syncFlush mutations with per-request loaders
 */

import DataLoader from 'dataloader'
import { GraphQLError, GraphQLScalarType, Kind, type ValueNode } from 'graphql'
import type { AuthenticatedUser } from '../middleware/auth.js'
import type { DomainEvent, DomainStore, Incident, Responder as DomainResponder } from '../lib/domainStore.ts'

export type Row = Record<string, unknown>
export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>

export interface HealthProbe {
  ping: () => Promise<{ ok: boolean; latencyMs: number }>
  stats: () => { total: number; active: number; idle: number; waiting: number; maxConnections: number }
}

export const MAX_PAGE_SIZE = 100
export const DEFAULT_PAGE_SIZE = 20

export interface Loaders {
  requestById: DataLoader<string, Row | null>
  respondersByRequest: DataLoader<string, Row[]>
  verificationsByWallet: DataLoader<{ wallet: string; limit: number }, Row[], string>
}

export interface Loader<K, V> {
  load(key: K): Promise<V>
  clear(): void
}

export interface RequestLoaders {
  viewerId: string
  incident: Loader<string, Incident | null>
  respondersByIncident: Loader<string, DomainResponder[]>
  lastEventByResponder: Loader<string, DomainEvent | null>
  eventsByIncident: Loader<string, DomainEvent[]>
  responder: Loader<string, DomainResponder | null>
}

export interface GraphQLContext {
  query?: QueryFn
  health?: HealthProbe
  loaders?: any
  user?: AuthenticatedUser | null
  store?: DomainStore
  viewerId?: string
}

export function clampLimit(value: number | null | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), 1), MAX_PAGE_SIZE)
}

export function clampOffset(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0
  return Math.max(Math.trunc(value), 0)
}

const toIso = (v: unknown): string | null => {
  if (v == null) return null
  return v instanceof Date ? v.toISOString() : String(v)
}

function groupByKey(keys: readonly string[], rows: Row[], column: string): Row[][] {
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const k = String(row[column])
    const list = groups.get(k)
    if (list) list.push(row)
    else groups.set(k, [row])
  }
  return keys.map((k) => groups.get(String(k)) ?? [])
}

export function createLoaders(query: QueryFn): Loaders {
  return {
    requestById: new DataLoader<string, Row | null>(async (ids) => {
      const { rows } = await query('SELECT * FROM requests WHERE id = ANY($1)', [[...ids]])
      const byId = new Map(rows.map((r) => [String(r.id), r]))
      return ids.map((id) => byId.get(String(id)) ?? null)
    }),

    respondersByRequest: new DataLoader<string, Row[]>(async (requestIds) => {
      const { rows } = await query('SELECT * FROM responders WHERE request_id = ANY($1)', [[...requestIds]])
      return groupByKey(requestIds, rows, 'request_id')
    }),

    verificationsByWallet: new DataLoader<{ wallet: string; limit: number }, Row[], string>(
      async (keys) => {
        const wallets = [...new Set(keys.map((k) => k.wallet))]
        const maxLimit = Math.max(...keys.map((k) => k.limit))
        const { rows } = await query(
          `SELECT * FROM (
             SELECT v.*, row_number() OVER (PARTITION BY wallet ORDER BY recorded_at DESC) AS rn
             FROM expert_verifications v WHERE wallet = ANY($1)
           ) ranked WHERE rn <= $2 ORDER BY wallet, recorded_at DESC`,
          [wallets, maxLimit]
        )
        const grouped = groupByKey(wallets, rows, 'wallet')
        const byWallet = new Map(wallets.map((w, i) => [w, grouped[i]]))
        return keys.map((k) => (byWallet.get(k.wallet) ?? []).slice(0, k.limit))
      },
      { cacheKeyFn: (k) => `${k.wallet}\u0000${k.limit}` }
    ),
  }
}

/**
 * Minimal DataLoader: batches all `.load()` calls made in one microtask tick
 * into a single batch function call, caches per key, and rejects the whole
 * batch on error.
 */
export function createBatchLoader<K, V>(
  batchFn: (keys: K[]) => Promise<Map<K, V>> | Map<K, V>,
  options: { cacheKeyFn?: (key: K) => string } = {}
): Loader<K, V> {
  const cache = new Map<string, Promise<V>>()
  const queue = new Map<string, { key: K; resolve: (value: V) => void; reject: (error: unknown) => void }>()
  let scheduled = false
  const keyOf = options.cacheKeyFn ?? ((key: K) => String(key))

  const dispatch = () => {
    scheduled = false
    const batch = [...queue.values()]
    queue.clear()
    if (batch.length === 0) return
    Promise.resolve()
      .then(() => batchFn(batch.map((entry) => entry.key)))
      .then((result) => {
        for (const entry of batch) {
          if (result.has(entry.key)) entry.resolve(result.get(entry.key) as V)
          else entry.resolve(undefined as V)
        }
      })
      .catch((error) => {
        for (const entry of batch) entry.reject(error)
      })
  }

  return {
    load(key: K): Promise<V> {
      const cacheKey = keyOf(key)
      const cached = cache.get(cacheKey)
      if (cached) return cached

      const promise = new Promise<V>((resolve, reject) => {
        queue.set(cacheKey, { key, resolve, reject })
        if (!scheduled) {
          scheduled = true
          Promise.resolve().then(dispatch)
        }
      })
      cache.set(cacheKey, promise)
      return promise
    },
    clear() {
      cache.clear()
      queue.clear()
    },
  }
}

export function createRequestLoaders(store: DomainStore, viewerId = 'anonymous'): RequestLoaders {
  return {
    viewerId,
    incident: createBatchLoader(async (ids: string[]) => {
      const rows = store.getIncidentsByIds(ids)
      return new Map(rows.map((row) => [row.id, row]))
    }),
    respondersByIncident: createBatchLoader(async (ids: string[]) => {
      return store.getRespondersForIncidents(ids)
    }),
    lastEventByResponder: createBatchLoader(async (ids: string[]) => {
      return store.getLastEventsByResponderIds(ids)
    }),
    eventsByIncident: createBatchLoader(async (ids: string[]) => {
      return store.getEventsForIncidents(ids)
    }),
    responder: createBatchLoader(async (ids: string[]) => {
      const rows = store.getRespondersByIds(ids)
      return new Map(rows.map((row) => [row.id, row]))
    }),
  }
}

type IncidentSource = Incident & {
  responders: () => Promise<Array<DomainResponder & { lastEvent: () => Promise<DomainEvent | null> }>>
  events: () => Promise<DomainEvent[]>
}

export function decorateIncident(incident: Incident, loaders: RequestLoaders): IncidentSource {
  return {
    ...incident,
    responders: async () => {
      const responders = await loaders.respondersByIncident.load(incident.id)
      return responders.map((responder) => ({
        ...responder,
        lastEvent: () => loaders.lastEventByResponder.load(responder.id),
      }))
    },
    events: () => loaders.eventsByIncident.load(incident.id),
  }
}

function syncSuccess(incident: Incident, loaders: RequestLoaders) {
  return {
    __typename: 'SyncSuccess',
    ok: true,
    serverVersion: incident.version,
    incident: decorateIncident(incident, loaders),
  }
}

export const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON (the untyped remainder of a database row).',
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral(ast: ValueNode): unknown {
    switch (ast.kind) {
      case Kind.STRING:
      case Kind.BOOLEAN:
        return ast.value
      case Kind.INT:
      case Kind.FLOAT:
        return Number(ast.value)
      case Kind.NULL:
        return null
      default:
        throw new GraphQLError('JSON literals must be scalar values; pass objects as variables')
    }
  },
})

function rest(row: Row, typed: string[]): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) {
    if (!typed.includes(k) && k !== 'rn') out[k] = v
  }
  return out
}

export function createRootValue() {
  return {
    incident: async (args: { id: string }, context: GraphQLContext) => {
      const incident = await context.loaders.incident.load(args.id)
      return incident ? decorateIncident(incident, context.loaders) : null
    },
    incidents: async (
      args: { limit?: number; cursor?: string | null },
      context: GraphQLContext
    ) => {
      const page = context.store!.listIncidents(args.limit ?? 20, args.cursor)
      return {
        edges: page.items.map((incident) => ({
          node: decorateIncident(incident, context.loaders),
          cursor: incident.id,
        })),
        pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.nextCursor },
      }
    },
    events: async (
      args: { incidentId: string; limit?: number; cursor?: string | null },
      context: GraphQLContext
    ) => {
      const page = context.store!.getEventsByIncident(args.incidentId, {
        limit: args.limit,
        cursor: args.cursor,
      })
      return {
        edges: page.items.map((event) => ({ node: event, cursor: event.cursor })),
        pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.nextCursor },
      }
    },
    assignResponder: async (
      args: { input: { incidentId: string; responderId: string; expectedVersion?: number } },
      context: GraphQLContext
    ) => {
      try {
        const incident = context.store!.assignResponder(
          args.input.incidentId,
          args.input.responderId,
          args.input.expectedVersion
        )
        return syncSuccess(incident, context.loaders)
      } catch (error) {
        const typed = error as { code?: string; serverVersion?: number; mergeProposal?: Record<string, unknown> }
        if (typed.code === 'conflict') {
          return {
            __typename: 'SyncConflict',
            conflict: true,
            serverVersion: typed.serverVersion ?? 0,
            mergeProposal: typed.mergeProposal ?? {},
          }
        }
        return {
          __typename: 'ValidationError',
          error: (error as Error)?.message ?? 'assign_failed',
          issues: [{ path: 'expectedVersion', message: (error as Error)?.message ?? 'conflict' }],
        }
      }
    },
    syncFlush: async (
      args: { input: { incidentId: string; baseVersion: number; patch: Record<string, unknown> } },
      context: GraphQLContext
    ) => {
      const result = context.store!.syncFlush(args.input)
      if (result.__typename === 'SyncSuccess') {
        return syncSuccess(result.incident, context.loaders)
      }
      return result
    },
  }
}

export const resolvers = {
  JSON: JSONScalar,

  SyncFlushResult: {
    __resolveType(obj: { __typename?: string }) {
      return obj.__typename || 'SyncSuccess'
    },
  },

  AssignResult: {
    __resolveType(obj: { __typename?: string }) {
      return obj.__typename || 'SyncSuccess'
    },
  },

  Query: {
    health: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const ping = await ctx.health!.ping()
      return {
        status: ping.ok ? 'ok' : 'degraded',
        database: ping.ok,
        databaseLatencyMs: ping.latencyMs,
        pool: ctx.health!.stats(),
      }
    },

    requests: async (
      _: unknown,
      args: { status?: string | null; limit?: number | null; offset?: number | null },
      ctx: GraphQLContext
    ) => {
      const limit = clampLimit(args.limit, DEFAULT_PAGE_SIZE)
      const offset = clampOffset(args.offset)
      const { rows } = args.status
        ? await ctx.query!(
            'SELECT * FROM requests WHERE status = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
            [args.status, limit, offset]
          )
        : await ctx.query!('SELECT * FROM requests ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset])
      return rows
    },

    request: (_: unknown, args: { id: string }, ctx: GraphQLContext) => ctx.loaders.requestById.load(args.id),

    verifications: (_: unknown, args: { wallet: string; limit?: number | null }, ctx: GraphQLContext) =>
      ctx.loaders.verificationsByWallet.load({ wallet: args.wallet, limit: clampLimit(args.limit, 10) }),

    me: (_: unknown, __: unknown, ctx: GraphQLContext) =>
      ctx.user ? { publicKey: ctx.user.publicKey, algorithm: ctx.user.algorithm } : null,

    incident: async (_: unknown, args: { id: string }, context: GraphQLContext) => {
      const root = createRootValue()
      return root.incident(args, context)
    },

    incidents: async (
      _: unknown,
      args: { limit?: number; cursor?: string | null },
      context: GraphQLContext
    ) => {
      const root = createRootValue()
      return root.incidents(args, context)
    },

    events: async (
      _: unknown,
      args: { incidentId: string; limit?: number; cursor?: string | null },
      context: GraphQLContext
    ) => {
      const root = createRootValue()
      return root.events(args, context)
    },
  },

  Mutation: {
    assignResponder: async (
      _: unknown,
      args: { input: { incidentId: string; responderId: string; expectedVersion?: number } },
      context: GraphQLContext
    ) => {
      const root = createRootValue()
      return root.assignResponder(args, context)
    },
    syncFlush: async (
      _: unknown,
      args: { input: { incidentId: string; baseVersion: number; patch: Record<string, unknown> } },
      context: GraphQLContext
    ) => {
      const root = createRootValue()
      return root.syncFlush(args, context)
    },
  },

  HelpRequest: {
    id: (r: Row) => String(r.id),
    status: (r: Row) => (r.status == null ? null : String(r.status)),
    createdAt: (r: Row) => toIso(r.created_at),
    attributes: (r: Row) => rest(r, ['id', 'status', 'created_at']),
    responders: (r: Row, _: unknown, ctx: GraphQLContext) => ctx.loaders.respondersByRequest.load(String(r.id)),
    responderCount: async (r: Row, _: unknown, ctx: GraphQLContext) =>
      (await ctx.loaders.respondersByRequest.load(String(r.id))).length,
    arrivedCount: async (r: Row, _: unknown, ctx: GraphQLContext) =>
      (await ctx.loaders.respondersByRequest.load(String(r.id))).filter((x) => x.arrived === true).length,
  },

  Responder: {
    id: (r: any) => r.id ?? null,
    incidentId: (r: any) => r.incidentId ?? null,
    name: (r: any) => r.name ?? null,
    status: (r: any) => r.status ?? null,
    location: (r: any) => r.location ?? null,
    lastEvent: (r: any) => (typeof r.lastEvent === 'function' ? r.lastEvent() : r.lastEvent ?? null),

    requestId: (r: Row) => (r.request_id != null ? String(r.request_id) : null),
    arrived: (r: Row) => r.arrived === true,
    attributes: (r: Row) => rest(r, ['request_id', 'arrived']),
  },

  Verification: {
    wallet: (r: Row) => String(r.wallet),
    recordedAt: (r: Row) => toIso(r.recorded_at),
    attributes: (r: Row) => rest(r, ['wallet', 'recorded_at']),
  },
}

export default createRootValue
