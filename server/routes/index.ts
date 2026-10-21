import type { Express } from 'express';
import { createDispatchRouter } from './dispatch.ts';
import { createEventsRouter } from './events.ts';
import { createSyncRouter } from './sync.ts';
import { installGraphQLRoutes } from '../graphql/server.ts';
import type { DomainStore } from '../lib/domainStore.ts';

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
 */
export function installDomainRoutes(app: Express, options: DomainRoutesOptions = {}): boolean {
  if (installed.has(app)) return false;
  installed.add(app);

  app.use('/api/dispatch', createDispatchRouter({ store: options.store }));
  app.use('/api/events', createEventsRouter({ store: options.store }));
  app.use('/api/sync', createSyncRouter({ store: options.store }));
  installGraphQLRoutes(app, { store: options.store, path: options.graphqlPath ?? '/graphql' });
  return true;
}
