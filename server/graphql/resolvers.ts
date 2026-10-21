/**
 * server/graphql/resolvers.ts — resolvers and per-request DataLoaders (#528)
 *
 * Every nested field goes through a DataLoader, so a page of N requests costs
 * one responders query instead of N. Loaders are created per request: their
 * cache must never outlive the request or one caller could read another's
 * stale data.
 */
import DataLoader from 'dataloader'
import { GraphQLError, GraphQLScalarType, Kind, type ValueNode } from 'graphql'
import type { AuthenticatedUser } from '../middleware/auth.js'

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

export interface GraphQLContext {
  query: QueryFn
  health: HealthProbe
  loaders: Loaders
  user: AuthenticatedUser | null
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

/** Group rows under their key, returning one array per requested key in order. */
function groupByKey(keys: readonly string[], rows: Row[], column: string): Row[][] {
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const k = String(row[column])
    const list = groups.get(k)
    if (list) list.push(row)
    else groups.set(k, [row])
  }
  return keys.map((k) => groups.get(k) ?? [])
}

export function createLoaders(query: QueryFn): Loaders {
  return {
    requestById: new DataLoader<string, Row | null>(async (ids) => {
      const { rows } = await query('SELECT * FROM requests WHERE id = ANY($1)', [[...ids]])
      const byId = new Map(rows.map((r) => [String(r.id), r]))
      return ids.map((id) => byId.get(id) ?? null)
    }),

    respondersByRequest: new DataLoader<string, Row[]>(async (requestIds) => {
      const { rows } = await query('SELECT * FROM responders WHERE request_id = ANY($1)', [[...requestIds]])
      return groupByKey(requestIds, rows, 'request_id')
    }),

    // Callers may ask for different limits in one tick; fetch the largest and
    // slice per caller. The window function keeps it to one query.
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

/** Columns already exposed as typed fields; the rest go into `attributes`. */
function rest(row: Row, typed: string[]): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) {
    if (!typed.includes(k) && k !== 'rn') out[k] = v
  }
  return out
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

export const resolvers = {
  JSON: JSONScalar,

  Query: {
    health: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const ping = await ctx.health.ping()
      return {
        status: ping.ok ? 'ok' : 'degraded',
        database: ping.ok,
        databaseLatencyMs: ping.latencyMs,
        pool: ctx.health.stats(),
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
        ? await ctx.query(
            'SELECT * FROM requests WHERE status = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
            [args.status, limit, offset]
          )
        : await ctx.query('SELECT * FROM requests ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset])
      return rows
    },

    request: (_: unknown, args: { id: string }, ctx: GraphQLContext) => ctx.loaders.requestById.load(args.id),

    verifications: (_: unknown, args: { wallet: string; limit?: number | null }, ctx: GraphQLContext) =>
      ctx.loaders.verificationsByWallet.load({ wallet: args.wallet, limit: clampLimit(args.limit, 10) }),

    me: (_: unknown, __: unknown, ctx: GraphQLContext) =>
      ctx.user ? { publicKey: ctx.user.publicKey, algorithm: ctx.user.algorithm } : null,
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
    requestId: (r: Row) => String(r.request_id),
    arrived: (r: Row) => r.arrived === true,
    attributes: (r: Row) => rest(r, ['request_id', 'arrived']),
  },

  Verification: {
    wallet: (r: Row) => String(r.wallet),
    recordedAt: (r: Row) => toIso(r.recorded_at),
    attributes: (r: Row) => rest(r, ['wallet', 'recorded_at']),
  },
}
