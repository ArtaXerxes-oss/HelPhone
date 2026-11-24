import type { Express } from 'express';
import { createDispatchRouter } from './dispatch.ts';
import { createEventsRouter } from './events.ts';
import { createSyncRouter } from './sync.ts';
import { createDocsRouter } from './docs.ts';
import { createRadioGatewayRouter } from './radioGateway.ts';
import { stagingRouterFromEnv } from './staging.ts';
import { installGraphQLRoutes } from '../graphql/server.ts';
import { getDomainStore, type DomainStore } from '../lib/domainStore.ts';

export interface DomainRoutesOptions {
  store?: DomainStore;
  graphqlPath?: string;
}

const installed = new WeakSet<object>();

/**
 * Mount the canonical domain surface exactly once per app.
 *
 * REST and GraphQL are installed from the same store instance; that is what
 * guarantees a write on either surface is visible to the other immediately.
 *
 * Versioned `/api/v1/*` and legacy unversioned `/api/*` (`v0`) run side-by-side
 * during the deprecation window (#947), while `/graphql` remains backward
 * compatible across versions.
 */
export function installDomainRoutes(app: Express, options: DomainRoutesOptions = {}): boolean {
  if (installed.has(app)) return false;
  installed.add(app);

  app.use('/api/dispatch', createDispatchRouter({ store: options.store }));
  app.use('/api/events', createEventsRouter({ store: options.store }));
  app.use('/api/sync', createSyncRouter({ store: options.store }));
  app.use('/api/radio', createRadioGatewayRouter({ store: options.store ?? getDomainStore() }));
  app.use('/api/staging', stagingRouterFromEnv());
  app.use('/docs', createDocsRouter());

  const graphqlPath = options.graphqlPath ?? '/graphql';
  app.use(graphqlPath, graphqlCompatibilityMiddleware());
  installGraphQLRoutes(app, { store: options.store, path: graphqlPath });
  return true;
}
