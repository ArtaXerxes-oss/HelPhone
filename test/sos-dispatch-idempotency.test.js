// @vitest-environment node
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDispatchRouter } from '../server/routes/dispatch.ts';
import { DomainStore } from '../server/lib/domainStore.ts';

const HERE = { lat: 57.64911, lng: 10.40744 };
const NEAR_HERE = { lat: 57.6492, lng: 10.4075 }; // ~15 m away
const FAR = { lat: 34.0522, lng: -118.2437 };

function buildApp({ enabled = true } = {}) {
  const store = new DomainStore({ seed: false });
  const app = express();
  app.use(express.json());
  app.use('/api/dispatch', createDispatchRouter({ store, enabled }));
  return { app, store };
}

describe('POST /api/dispatch/sos — server-wide idempotency (#941)', () => {
  it('two devices pressing in the same bucket open exactly one incident', async () => {
    const { app, store } = buildApp();

    const first = await request(app)
      .post('/api/dispatch/sos')
      .send({ idempotencyKey: 'sos-100', source: 'hardware-key', force: true, location: HERE });
    const second = await request(app)
      .post('/api/dispatch/sos')
      .send({ idempotencyKey: 'sos-100', source: 'hardware-key', force: true, location: NEAR_HERE });

    expect(first.status).toBe(201);
    expect(first.body.status).toBe('created');
    expect(first.body.incident.id).toBe('SOS-100');
    expect(first.body.incident.priority).toBe('critical');

    expect(second.status).toBe(200);
    expect(second.body.status).toBe('duplicate');
    expect(second.body.incident.id).toBe('SOS-100');
    expect(store.listActiveIncidents(10)).toHaveLength(1);
  });

  it('a retry of the same key is a duplicate, not a second incident', async () => {
    const { app, store } = buildApp();
    const body = { idempotencyKey: 'sos-7', force: true, location: HERE };

    await request(app).post('/api/dispatch/sos').send(body);
    const retry = await request(app).post('/api/dispatch/sos').send(body);

    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('duplicate');
    expect(store.listActiveIncidents(10)).toHaveLength(1);
  });
});

describe('POST /api/dispatch/sos — geofence gate', () => {
  it('auto-dispatch without confirm is accepted near an unresolved incident', async () => {
    const { app } = buildApp();
    await request(app)
      .post('/api/dispatch/sos')
      .send({ idempotencyKey: 'sos-1', force: true, location: HERE });

    const res = await request(app)
      .post('/api/dispatch/sos')
      .send({ idempotencyKey: 'sos-2', location: NEAR_HERE });

    expect(res.status).toBe(201);
    expect(res.body.incident.id).toBe('SOS-2');
  });

  it('auto-dispatch far from every incident is declined and creates nothing', async () => {
    const { app, store } = buildApp();

    const res = await request(app)
      .post('/api/dispatch/sos')
      .send({ idempotencyKey: 'sos-3', location: FAR });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'needs_confirm', idempotencyKey: 'sos-3' });
    expect(store.listActiveIncidents(10)).toHaveLength(0);
  });

  it('auto-dispatch without a location is declined, not guessed', async () => {
    const { app, store } = buildApp();

    const res = await request(app).post('/api/dispatch/sos').send({ idempotencyKey: 'sos-4' });

    expect(res.status).toBe(202);
    expect(store.listActiveIncidents(10)).toHaveLength(0);
  });

  it('operator-confirmed SOS without a location is rejected: an incident needs coordinates', async () => {
    const { app, store } = buildApp();

    const res = await request(app)
      .post('/api/dispatch/sos')
      .send({ idempotencyKey: 'sos-5', force: true });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('validation_failed');
    expect(store.listActiveIncidents(10)).toHaveLength(0);
  });
});

describe('POST /api/dispatch/sos — validation and flag', () => {
  it('rejects keys that are not a sos bucket', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/dispatch/sos')
      .send({ idempotencyKey: 'loc-1', force: true, location: HERE });
    expect(res.status).toBe(422);
  });

  it('returns 503 when encrypted dispatch is disabled', async () => {
    const { app } = buildApp({ enabled: false });
    const res = await request(app)
      .post('/api/dispatch/sos')
      .send({ idempotencyKey: 'sos-9', force: true, location: HERE });
    expect(res.status).toBe(503);
  });
});
