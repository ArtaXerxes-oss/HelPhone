/**
 * Express mount for the GraphQL contract.
 *
 * Context (and therefore every DataLoader) is created per request. There is
 * deliberately no module-scope loader: that was the cross-request privacy bug.
 */

import type { Request, Response } from 'express';
import { graphql } from 'graphql';
import { schema } from './schema.ts';
import { createRootValue, createRequestLoaders, type GraphQLContext } from './resolvers.ts';
import { getDomainStore, type DomainStore } from '../lib/domainStore.ts';

export interface GraphQLRouteOptions {
  store?: DomainStore;
  path?: string;
}

const installed = new WeakSet<object>();

export function createGraphQLContext(
  store: DomainStore,
  viewerId = 'anonymous',
): GraphQLContext {
  return {
    store,
    viewerId,
    // New loader instance per request; never shared across users.
    loaders: createRequestLoaders(store, viewerId),
  };
}

export async function executeGraphQL(
  input: {
    query: string;
    variables?: Record<string, unknown> | null;
    operationName?: string | null;
    viewerId?: string;
  },
  options: { store?: DomainStore } = {},
) {
  const store = options.store ?? getDomainStore();
  const context = createGraphQLContext(store, input.viewerId ?? 'anonymous');
  return graphql({
    schema,
    source: input.query,
    rootValue: createRootValue(),
    contextValue: context,
    variableValues: input.variables ?? undefined,
    operationName: input.operationName ?? undefined,
  });
}

export function createGraphQLHandler(options: GraphQLRouteOptions = {}) {
  const store = options.store ?? getDomainStore();
  return async function graphqlHandler(req: Request, res: Response) {
    const body = req.body || {};
    const query = typeof body.query === 'string' ? body.query : '';
    if (!query) {
      res.status(400).json({ errors: [{ message: 'query is required' }] });
      return;
    }
    const viewerId = String(req.header('x-viewer-id') || 'anonymous');
    const result = await executeGraphQL(
      {
        query,
        variables: body.variables,
        operationName: body.operationName,
        viewerId,
      },
      { store },
    );
    res.status(200).json(result);
  };
}

export function installGraphQLRoutes(app: object, options: GraphQLRouteOptions = {}): boolean {
  if (installed.has(app)) return false;
  installed.add(app);
  const path = options.path ?? '/graphql';
  const expressApp = app as { post: (path: string, handler: unknown) => void; get: (path: string, handler: unknown) => void };
  expressApp.post(path, createGraphQLHandler(options));
  // Publish the versioned SDL for docs/drift tooling. This is not a second
  // API surface: it is the same artifact the server executes.
  expressApp.get(`${path}/schema`, (_req: Request, res: Response) => {
    import('./schema.ts').then(({ typeDefs }) => {
      res.type('text/plain').send(typeDefs);
    });
  });
  return true;
}

export default installGraphQLRoutes;
