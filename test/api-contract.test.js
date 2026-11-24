// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { installDomainRoutes } from '../server/routes/index.ts';
import { DomainStore } from '../server/lib/domainStore.ts';
import { createGraphQLContext, executeGraphQL } from '../server/graphql/server.ts';
import { resetSqlCache } from '../server/lib/sqlCache.ts';

const INCIDENT_QUERY = `
  query Incident($id: ID!) {
    incident(id: $id) {
      id
      status
      priority
      version
      location { lat lng }
      responders {
        id
        incidentId
        status
        location { lat lng }
        lastEvent { id type cursor }
      }
    }
  }
`;

const EVENTS_QUERY = `
  query Events($id: ID!, $limit: Int, $cursor: String) {
    events(incidentId: $id, limit: $limit, cursor: $cursor) {
      edges { cursor node { id type cursor } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const FLUSH_MUTATION = `
  mutation Flush($input: SyncFlushInput!) {
    syncFlush(input: $input) {
      __typename
      ... on SyncSuccess { ok serverVersion incident { id version } }
      ... on SyncConflict { conflict serverVersion mergeProposal }
      ... on ValidationError { error issues { path message } }
    }
  }
`;

const ASSIGN_MUTATION = `
  mutation Assign($input: AssignResponderInput!) {
    assignResponder(input: $input) {
      __typename
      ... on SyncSuccess { ok serverVersion incident { id version } }
      ... on SyncConflict { conflict serverVersion mergeProposal }
      ... on ValidationError { error issues { path message } }
    }
  }
`;

describe('REST ↔ GraphQL contract parity', () => {
  let store;
  let app;

  beforeEach(() => {
    store = new DomainStore();
    store.resetQueryCount();
    resetSqlCache();
    app = express();
    app.use(express.json());
    installDomainRoutes(app, { store });
  });

  it('returns the same incident, responder, and last-event fields on both surfaces', async () => {
    const rest = await request(app).get('/api/dispatch/INC-1042?nocache=1');
    expect(rest.status).toBe(200);

    const gql = await executeGraphQL(
      { query: INCIDENT_QUERY, variables: { id: 'INC-1042' } },
      { store },
    );
    expect(gql.errors).toBeUndefined();

    const restIncident = rest.body.incident;
    const gqlIncident = gql.data.incident;

    expect(restIncident).toMatchObject({
      id: gqlIncident.id,
      status: gqlIncident.status,
      priority: gqlIncident.priority,
      version: gqlIncident.version,
      location: gqlIncident.location,
    });
    expect(restIncident.responders).toHaveLength(40);
    expect(restIncident.responders).toHaveLength(gqlIncident.responders.length);

    for (let i = 0; i < restIncident.responders.length; i++) {
      const restResponder = restIncident.responders[i];
      const gqlResponder = gqlIncident.responders[i];
      expect(restResponder).toMatchObject({
        id: gqlResponder.id,
        incidentId: gqlResponder.incidentId,
        status: gqlResponder.status,
        location: gqlResponder.location,
      });
      expect(restResponder.lastEvent?.id ?? null).toBe(gqlResponder.lastEvent?.id ?? null);
      expect(restResponder.lastEvent?.cursor ?? null).toBe(gqlResponder.lastEvent?.cursor ?? null);
    }
  });

  it('batches GraphQL nested reads to ≤4 store queries instead of 1+N+N', async () => {
    store.resetQueryCount();
    const gql = await executeGraphQL(
      { query: INCIDENT_QUERY, variables: { id: 'INC-1042' } },
      { store },
    );
    expect(gql.errors).toBeUndefined();
    expect(store.getQueryCount()).toBeLessThanOrEqual(4);
    // The naive resolver would issue incident + 40 responders + 40 events = 81.
    expect(store.getQueryCount()).toBeLessThan(81);
  });

  it('uses two store queries for the hand-optimised REST bundle', async () => {
    store.resetQueryCount();
    const rest = await request(app).get('/api/dispatch/INC-1042?nocache=1');
    expect(rest.status).toBe(200);
    expect(store.getQueryCount()).toBeLessThanOrEqual(2);
  });

  it('creates request-scoped loaders so one context cannot serve another context stale data', async () => {
    const ctxA = createGraphQLContext(store, 'user-a');
    const ctxB = createGraphQLContext(store, 'user-b');
    expect(ctxA.loaders).not.toBe(ctxB.loaders);

    const before = await ctxA.loaders.responder.load('R-001');
    expect(before.location.lat).toBeCloseTo(6.5201, 6);
    expect(before.location.lng).toBeCloseTo(3.3701, 6);

    store.updateResponderLocation('R-001', { lat: 9.999, lng: 8.888 });

    // A's cache is isolated; B sees the write.
    const cachedForA = await ctxA.loaders.responder.load('R-001');
    const freshForB = await ctxB.loaders.responder.load('R-001');
    expect(cachedForA.location.lat).toBeCloseTo(6.5201, 6);
    expect(freshForB.location).toEqual({ lat: 9.999, lng: 8.888 });
  });

  it('returns identical 409 conflict payloads from REST and GraphQL', async () => {
    const rest = await request(app)
      .post('/api/dispatch/INC-1042/assign')
      .send({ responderId: 'R-002', expectedVersion: 2 });
    expect(rest.status).toBe(409);
    expect(rest.body).toMatchObject({ conflict: true, serverVersion: 3 });

    const gql = await executeGraphQL(
      {
        query: ASSIGN_MUTATION,
        variables: { input: { incidentId: 'INC-1042', responderId: 'R-002', expectedVersion: 2 } },
      },
      { store },
    );
    expect(gql.errors).toBeUndefined();
    expect(gql.data.assignResponder).toMatchObject({
      __typename: 'SyncConflict',
      conflict: true,
      serverVersion: rest.body.serverVersion,
      mergeProposal: rest.body.mergeProposal,
    });
  });

  it('returns identical 409 conflict payloads from the REST flush and GraphQL syncFlush', async () => {
    const input = { incidentId: 'INC-1042', baseVersion: 2, patch: { priority: 'high' } };
    const rest = await request(app).post('/api/sync/flush').send(input);
    expect(rest.status).toBe(409);
    expect(rest.body).toMatchObject({ conflict: true, serverVersion: 3 });

    const gql = await executeGraphQL({ query: FLUSH_MUTATION, variables: { input } }, { store });
    expect(gql.errors).toBeUndefined();
    expect(gql.data.syncFlush).toMatchObject({
      __typename: 'SyncConflict',
      conflict: true,
      serverVersion: rest.body.serverVersion,
      mergeProposal: rest.body.mergeProposal,
    });
  });

  it('returns identical 422 validation issues from REST and GraphQL', async () => {
    const input = { incidentId: 'INC-1042', baseVersion: 3, patch: { bogus: true } };
    const rest = await request(app).post('/api/sync/flush').send(input);
    expect(rest.status).toBe(422);
    expect(rest.body.error).toBe('validation_failed');
    expect(rest.body.issues).toEqual(
      expect.arrayContaining([{ path: 'patch.bogus', message: 'unsupported field' }]),
    );

    const gql = await executeGraphQL({ query: FLUSH_MUTATION, variables: { input } }, { store });
    expect(gql.errors).toBeUndefined();
    expect(gql.data.syncFlush).toMatchObject({
      __typename: 'ValidationError',
      error: rest.body.error,
      issues: rest.body.issues,
    });
  });

  it('returns 422 for a malformed REST body before touching the store', async () => {
    store.resetQueryCount();
    const rest = await request(app).post('/api/dispatch/INC-1042/assign').send({});
    expect(rest.status).toBe(422);
    expect(rest.body.issues[0]).toMatchObject({ path: 'responderId' });
    expect(store.getQueryCount()).toBe(0);
  });

  it('paginates events with the same cursor on both surfaces', async () => {
    const restFirst = await request(app).get('/api/events?incidentId=INC-1042&limit=5');
    expect(restFirst.status).toBe(200);
    expect(restFirst.body.events).toHaveLength(5);
    const restCursor = restFirst.body.nextCursor;
    expect(restCursor).toBeTruthy();

    const gqlFirst = await executeGraphQL(
      { query: EVENTS_QUERY, variables: { id: 'INC-1042', limit: 5 } },
      { store },
    );
    expect(gqlFirst.errors).toBeUndefined();
    expect(gqlFirst.data.events.pageInfo.endCursor).toBe(restCursor);
    expect(gqlFirst.data.events.edges.map((edge) => edge.node.id)).toEqual(
      restFirst.body.events.map((event) => event.id),
    );

    const restSecond = await request(app).get(
      `/api/events?incidentId=INC-1042&limit=5&cursor=${encodeURIComponent(restCursor)}`,
    );
    const gqlSecond = await executeGraphQL(
      { query: EVENTS_QUERY, variables: { id: 'INC-1042', limit: 5, cursor: restCursor } },
      { store },
    );
    expect(restSecond.body.events.map((event) => event.id)).toEqual(
      gqlSecond.data.events.edges.map((edge) => edge.node.id),
    );
  });

  it('invalidates the REST cache when a write happens, so GraphQL and REST converge', async () => {
    const before = await request(app).get('/api/dispatch/INC-1042');
    expect(before.body.incident.version).toBe(3);

    const write = await request(app)
      .post('/api/dispatch/INC-1042/assign')
      .send({ responderId: 'R-002', expectedVersion: 3 });
    expect(write.status).toBe(200);
    expect(write.body.incident.version).toBe(4);

    const after = await request(app).get('/api/dispatch/INC-1042');
    expect(after.body.incident.version).toBe(4);

    const gql = await executeGraphQL(
      {
        query: 'query($id: ID!){ incident(id: $id){ id version } }',
        variables: { id: 'INC-1042' },
      },
      { store },
    );
    expect(gql.data.incident.version).toBe(4);
  });

  it('accepts GraphQL over HTTP and rejects a missing query', async () => {
    const ok = await request(app)
      .post('/graphql')
      .send({ query: 'query($id: ID!){ incident(id: $id){ id } }', variables: { id: 'INC-1042' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.incident.id).toBe('INC-1042');

    const bad = await request(app).post('/graphql').send({});
    expect(bad.status).toBe(400);
  });
});
