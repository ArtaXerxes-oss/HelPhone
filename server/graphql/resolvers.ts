/**
 * Per-request DataLoader implementation + GraphQL root resolvers.
 *
 * The old resolvers hit the pool directly from nested fields, producing
 * 1 + N + N queries. Every nested field here goes through a request-scoped
 * loader; loaders are created in createGraphQLContext(), never at module
 * scope, so one user's responder positions can never leak into another
 * request's cache.
 */

import type { DomainEvent, DomainStore, Incident, Responder } from '../lib/domainStore.ts';

export interface GraphQLContext {
  store: DomainStore;
  viewerId: string;
  loaders: RequestLoaders;
}

export interface Loader<K, V> {
  load(key: K): Promise<V>;
  clear(): void;
}

/**
 * Minimal DataLoader: batches all `.load()` calls made in one microtask tick
 * into a single batch function call, caches per key, and rejects the whole
 * batch on error.
 */
export function createBatchLoader<K, V>(
  batchFn: (keys: K[]) => Promise<Map<K, V>> | Map<K, V>,
  options: { cacheKeyFn?: (key: K) => string } = {},
): Loader<K, V> {
  const cache = new Map<string, Promise<V>>();
  const queue = new Map<string, { key: K; resolve: (value: V) => void; reject: (error: unknown) => void }>();
  let scheduled = false;
  const keyOf = options.cacheKeyFn ?? ((key: K) => String(key));

  const dispatch = () => {
    scheduled = false;
    const batch = [...queue.values()];
    queue.clear();
    if (batch.length === 0) return;
    Promise.resolve()
      .then(() => batchFn(batch.map((entry) => entry.key)))
      .then((result) => {
        for (const entry of batch) {
          if (result.has(entry.key)) entry.resolve(result.get(entry.key) as V);
          else entry.resolve(undefined as V);
        }
      })
      .catch((error) => {
        for (const entry of batch) entry.reject(error);
      });
  };

  return {
    load(key: K): Promise<V> {
      const cacheKey = keyOf(key);
      const cached = cache.get(cacheKey);
      if (cached) return cached;

      const promise = new Promise<V>((resolve, reject) => {
        queue.set(cacheKey, { key, resolve, reject });
        if (!scheduled) {
          scheduled = true;
          Promise.resolve().then(dispatch);
        }
      });
      cache.set(cacheKey, promise);
      return promise;
    },
    clear() {
      cache.clear();
      queue.clear();
    },
  };
}

export interface RequestLoaders {
  viewerId: string;
  incident: Loader<string, Incident | null>;
  respondersByIncident: Loader<string, Responder[]>;
  lastEventByResponder: Loader<string, DomainEvent | null>;
  eventsByIncident: Loader<string, DomainEvent[]>;
  responder: Loader<string, Responder | null>;
}

export function createRequestLoaders(store: DomainStore, viewerId = 'anonymous'): RequestLoaders {
  return {
    viewerId,
    incident: createBatchLoader(async (ids: string[]) => {
      const rows = store.getIncidentsByIds(ids);
      return new Map(rows.map((row) => [row.id, row]));
    }),
    respondersByIncident: createBatchLoader(async (ids: string[]) => {
      return store.getRespondersForIncidents(ids);
    }),
    lastEventByResponder: createBatchLoader(async (ids: string[]) => {
      return store.getLastEventsByResponderIds(ids);
    }),
    eventsByIncident: createBatchLoader(async (ids: string[]) => {
      return store.getEventsForIncidents(ids);
    }),
    responder: createBatchLoader(async (ids: string[]) => {
      const rows = store.getRespondersByIds(ids);
      return new Map(rows.map((row) => [row.id, row]));
    }),
  };
}

type IncidentSource = Incident & {
  responders: () => Promise<Array<Responder & { lastEvent: () => Promise<DomainEvent | null> }>>;
  events: () => Promise<DomainEvent[]>;
};

/** Decorate a plain incident with lazy, batched nested fields. */
export function decorateIncident(incident: Incident, loaders: RequestLoaders): IncidentSource {
  return {
    ...incident,
    responders: async () => {
      const responders = await loaders.respondersByIncident.load(incident.id);
      return responders.map((responder) => ({
        ...responder,
        lastEvent: () => loaders.lastEventByResponder.load(responder.id),
      }));
    },
    events: () => loaders.eventsByIncident.load(incident.id),
  };
}

function syncSuccess(incident: Incident, loaders: RequestLoaders) {
  return {
    __typename: 'SyncSuccess',
    ok: true,
    serverVersion: incident.version,
    incident: decorateIncident(incident, loaders),
  };
}

function validationError(issues: Array<{ path: string; message: string }>) {
  return { __typename: 'ValidationError', error: 'validation_failed', issues };
}

/**
 * Root values for `graphql()`.
 *
 * Nested fields are functions on the returned objects; GraphQL's default field
 * resolver calls them with (args, context, info), which is how batching is
 * preserved without a resolver map library.
 */
export function createRootValue() {
  return {
    incident: async (args: { id: string }, context: GraphQLContext) => {
      const incident = await context.loaders.incident.load(args.id);
      return incident ? decorateIncident(incident, context.loaders) : null;
    },
    incidents: async (
      args: { limit?: number; cursor?: string | null },
      context: GraphQLContext,
    ) => {
      const page = context.store.listIncidents(args.limit ?? 20, args.cursor);
      return {
        edges: page.items.map((incident) => ({
          node: decorateIncident(incident, context.loaders),
          cursor: incident.id,
        })),
        pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.nextCursor },
      };
    },
    events: async (
      args: { incidentId: string; limit?: number; cursor?: string | null },
      context: GraphQLContext,
    ) => {
      const page = context.store.getEventsByIncident(args.incidentId, {
        limit: args.limit,
        cursor: args.cursor,
      });
      return {
        edges: page.items.map((event) => ({ node: event, cursor: event.cursor })),
        pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.nextCursor },
      };
    },
    assignResponder: async (
      args: { input: { incidentId: string; responderId: string; expectedVersion?: number } },
      context: GraphQLContext,
    ) => {
      try {
        const incident = context.store.assignResponder(
          args.input.incidentId,
          args.input.responderId,
          args.input.expectedVersion,
        );
        return syncSuccess(incident, context.loaders);
      } catch (error) {
        const typed = error as { code?: string; serverVersion?: number; mergeProposal?: Record<string, unknown> };
        if (typed.code === 'conflict') {
          return {
            __typename: 'SyncConflict',
            conflict: true,
            serverVersion: typed.serverVersion ?? 0,
            mergeProposal: typed.mergeProposal ?? {},
          };
        }
        return validationError([{ path: 'input', message: String((error as Error).message || error) }]);
      }
    },
    syncFlush: async (
      args: { input: { incidentId: string; baseVersion: number; patch: Record<string, unknown> } },
      context: GraphQLContext,
    ) => {
      const result = context.store.syncFlush(args.input);
      if (result.__typename === 'SyncSuccess') {
        return syncSuccess(result.incident, context.loaders);
      }
      return result;
    },
  };
}

export default createRootValue;
