/**
 * server/graphql/server.ts — Apollo Server 5 wiring for Express 5 (#751)
 */
import { ApolloServer } from '@apollo/server'
import { expressMiddleware } from '@as-integrations/express4'
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled'
import { GraphQLError, Kind, type ValidationRule } from 'graphql'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { hasAuthHeaders, verifyRequestAuth } from '../middleware/auth.js'
import { typeDefs } from './schema.js'
import { createLoaders, resolvers, type GraphQLContext, type HealthProbe, type QueryFn } from './resolvers.js'

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
    // Schema discovery is off in production; on locally.
    introspection: opts.introspection ?? process.env.NODE_ENV !== 'production',
    plugins: process.env.NODE_ENV === 'production' ? [ApolloServerPluginLandingPageDisabled()] : [],
  })
}

/**
 * Express handler that starts Apollo on first use. Apollo must be started
 * before its middleware is created, and `server/index.ts` builds the app
 * synchronously, so startup is deferred to the first request and memoised.
 */
export function createGraphQLHandler(deps: GraphQLDeps): RequestHandler {
  let ready: Promise<RequestHandler> | undefined
  const start = async () => {
    const server = createApolloServer()
    await server.start()
    return expressMiddleware(server, { context: async ({ req }: { req: Request }) => buildContext(req, deps) })
  }
  return (req: Request, res: Response, next: NextFunction) => {
    ready ??= start()
    ready.then((handler) => handler(req, res, next), (err) => {
      ready = undefined // let the next request retry instead of caching a failed start
      next(err)
    })
  }
}
