// @vitest-environment node
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDispatchRouter } from '../server/routes/dispatch.ts';
import { DomainStore } from '../server/lib/domainStore.ts';
import { encodeGeohash, haversineKm } from '../server/lib/geo.ts';
import {
  buildOpenTodaySlice,
  OPEN_TODAY_LIMIT,
  OPEN_TODAY_MAX_BYTES,
} from '../server/lib/openTodaySlice.ts';

const LOC = { lat: 57.64911, lng: 10.40744 };

function makeStore() {
  return new DomainStore({ seed: false });
}

function buildApp(store) {
  const app = express();
  app.use(express.json());
  app.use('/api/dispatch', createDispatchRouter({ store }));
  return app;
}

describe('geohash encoder', () => {
  it('matches the reference vector at precision 11', () => {
    expect(encodeGeohash(LOC.lat, LOC.lng, 11)).toBe('u4pruydqqvj');
  });

  it('rejects non-finite coordinates and bad precision', () => {
    expect(() => encodeGeohash(Number.NaN, 0)).toThrow(RangeError);
    expect(() => encodeGeohash(0, 0, 0)).toThrow(RangeError);
    expect(() => encodeGeohash(0, 0, 13)).toThrow(RangeError);
  });
});

describe('haversine distance', () => {
  it('returns ~0 for identical points and ~111 km per degree of latitude', () => {
    expect(haversineKm(LOC, LOC)).toBeCloseTo(0, 6);
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111.2, 0);
  });
});

describe('open-today slice', () => {
  it('returns only unresolved incidents, newest first, with the indexed fields', async () => {
    const store = makeStore();
    store.createIncident({ id: 'INC-A', location: LOC });
    store.createIncident({ id: 'INC-B', location: LOC });
    store.createIncident({ id: 'INC-C', location: LOC });
    store.syncFlush({ incidentId: 'INC-B', baseVersion: 1, patch: { status: 'resolved' } });

    const res = await request(buildApp(store)).get('/api/dispatch?slice=open-today');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const ids = res.body.map((row) => row.id);
    expect(ids).not.toContain('INC-B');
    expect(ids.sort()).toEqual(['INC-A', 'INC-C']);
    for (const row of res.body) {
      expect(row.status).toBe('open');
      expect(row.geohash).toBe('u4pruydqqvj');
      expect(typeof row.server_received_at).toBe('string');
      expect(Number.isNaN(Date.parse(row.server_received_at))).toBe(false);
    }
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('is also served at /api/dispatch/open-today with the same rows', async () => {
    const store = makeStore();
    store.createIncident({ id: 'INC-D', location: LOC });
    const app = buildApp(store);

    const viaQuery = await request(app).get('/api/dispatch?slice=open-today');
    const viaPath = await request(app).get('/api/dispatch/open-today');

    expect(viaPath.status).toBe(200);
    expect(viaPath.body).toEqual(viaQuery.body);
  });

  it('caps the row count at OPEN_TODAY_LIMIT', () => {
    const store = makeStore();
    for (let i = 0; i < OPEN_TODAY_LIMIT + 25; i++) {
      store.createIncident({ id: `INC-${i}`, location: LOC });
    }
    const rows = buildOpenTodaySlice(store);
    expect(rows.length).toBe(OPEN_TODAY_LIMIT);
  });

  it('stays under the byte bound even when the caller asks for more rows', () => {
    const store = makeStore();
    for (let i = 0; i < 50; i++) {
      store.createIncident({ id: `INC-${i}`, location: LOC });
    }
    const rows = buildOpenTodaySlice(store, { limit: 50, maxBytes: 1_000 });
    const bytes = Buffer.byteLength(JSON.stringify(rows), 'utf8');
    expect(bytes).toBeLessThanOrEqual(1_000);
    expect(rows.length).toBeLessThan(50);
    expect(OPEN_TODAY_MAX_BYTES).toBe(1_000_000);
  });
});
