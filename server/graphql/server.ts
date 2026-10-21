/**
 * server/graphql/server.ts — Apollo Server 5 wiring for Express 5 & GraphQL executor
 */

import { ApolloServer } from '@apollo/server'
import { expressMiddleware } from '@as-integrations/express4'
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled'
import { GraphQLError, Kind, graphql, type ValidationRule } from 'graphql'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { hasAuthHeaders, verifyRequestAuth } from '../middleware/auth.js'
import { typeDefs, schema } from './schema.ts'
import {
  createLoaders,
  resolvers,
  createRootValue,
  createRequestLoaders,
  type GraphQLContext,
  type HealthProbe,
  type QueryFn,
} from './resolvers.ts'
import { getDomainStore, type DomainStore } from '../lib/domainStore.ts'

/** Aliases let one request fan out into many root fields; bound that. */
export const MAX_ROOT_FIELDS = 10

export const maxRootFieldsRule: ValidationRule = (context) => ({
  OperationDefinition(node) {
    const count = node.selectionSet.selections.filter((s) => s.kind === Kind.FIELD).length
    if (count > MAX_ROOT_FIELDS) {
      context.reportError(
        new GraphQLError(`Operation has ${count} root fields; the limit is ${MAX_ROOT_FIELDS}`, { nodes: [node] })
      )
    }
  },
})

export interface GraphQLDeps {
  query: QueryFn
  health: HealthProbe
}

export interface GraphQLRouteOptions {
  store?: DomainStore
  path?: string
}

/** Build the per-request context. Bad credentials fail loudly; none means anonymous. */
export async function buildContext(req: Request, deps: GraphQLDeps): Promise<GraphQLContext> {
  let user = null
  if (hasAuthHeaders(req)) {
    const result = await verifyRequestAuth(req)
    if (!result.ok) {
      throw new GraphQLError(result.error, {
        extensions: { code: 'UNAUTHENTICATED', http: { status: result.status } },
      })
    }
    user = result.user
  }
  return { query: deps.query, health: deps.health, loaders: createLoaders(deps.query), user }
}

export function createApolloServer(opts: { introspection?: boolean } = {}) {
  return new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers,
    validationRules: [maxRootFieldsRule],
    introspection: opts.introspection ?? process.env.NODE_ENV !== 'production',
    plugins: process.env.NODE_ENV === 'production' ? [ApolloServerPluginLandingPageDisabled()] : [],
  })
}

export function createGraphQLContext(
  store: DomainStore,
  viewerId = 'anonymous'
): GraphQLContext {
  return {
    store,
    viewerId,
    loaders: createRequestLoaders(store, viewerId),
  }
}

export async function executeGraphQL(
  input: {
    query: string
    variables?: Record<string, unknown> | null
    operationName?: string | null
    viewerId?: string
  },
  options: { store?: DomainStore } = {}
) {
  const store = options.store ?? getDomainStore()
  const context = createGraphQLContext(store, input.viewerId ?? 'anonymous')
  return graphql({
    schema,
    source: input.query,
    rootValue: createRootValue(),
    contextValue: context,
    variableValues: input.variables ?? undefined,
    operationName: input.operationName ?? undefined,
  })
}

export function createGraphQLHandler(depsOrOptions: GraphQLDeps | GraphQLRouteOptions = {}): RequestHandler {
  if ('query' in depsOrOptions || 'health' in depsOrOptions) {
    const deps = depsOrOptions as GraphQLDeps
    let ready: Promise<RequestHandler> | undefined
    const start = async () => {
      const server = createApolloServer()
      await server.start()
      return expressMiddleware(server, { context: async ({ req }: { req: Request }) => buildContext(req, deps) })
    }
    return (req: Request, res: Response, next: NextFunction) => {
      ready ??= start()
      ready.then(
        (handler) => handler(req, res, next),
        (err) => {
          ready = undefined
          next(err)
        }
      )
    }
  }

  const options = depsOrOptions as GraphQLRouteOptions
  const store = options.store ?? getDomainStore()
  return async function graphqlHandler(req: Request, res: Response) {
    const body = req.body || {}
    const query = typeof body.query === 'string' ? body.query : ''
    if (!query) {
      res.status(400).json({ errors: [{ message: 'query is required' }] })
      return
    }
    const viewerId = String(req.header('x-viewer-id') || 'anonymous')
    const result = await executeGraphQL(
      {
        query,
        variables: body.variables,
        operationName: body.operationName,
        viewerId,
      },
      { store }
    )
    res.status(200).json(result)
  }
}

const installed = new WeakSet<object>()

export function installGraphQLRoutes(app: object, options: GraphQLRouteOptions = {}): boolean {
  if (installed.has(app)) return false
  installed.add(app)
  const path = options.path ?? '/graphql'
  const expressApp = app as {
    post: (path: string, handler: unknown) => void
    get: (path: string, handler: unknown) => void
  }
  expressApp.post(path, createGraphQLHandler(options))
  expressApp.get(`${path}/schema`, (_req: Request, res: Response) => {
    import('./schema.ts').then(({ typeDefs: td }) => {
      res.type('text/plain').send(td)
    })
  })
  return true
}

export default installGraphQLRoutes
