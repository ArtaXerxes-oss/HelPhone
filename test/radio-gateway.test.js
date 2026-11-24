// @vitest-environment node
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRadioGatewayRouter, radioGatewayEnabled } from '../server/routes/radioGateway.ts';
import {
  checkHamWire,
  gridSquareCenter,
  HAM_WIRE_FIELD_NAMES,
  PII_FIELD_NAMES,
} from '../server/lib/radioGateway.ts';
import { DomainStore } from '../server/lib/domainStore.ts';
import { HAM_WIRE_FIELDS, PII_FIELDS } from '../src/lib/radio/bandPlan.js';

describe('radio gateway mirrors the band plan (#939)', () => {
  it('its field lists match src/lib/radio/bandPlan.js exactly', () => {
    expect([...HAM_WIRE_FIELD_NAMES].sort()).toEqual([...HAM_WIRE_FIELDS].sort());
    expect([...PII_FIELD_NAMES].sort()).toEqual([...PII_FIELDS].sort());
  });
});

const MSG_ID = 0x1234abcd;
const INCIDENT_ID = 'RAD-H1234abcd';

function hamWire(overrides = {}) {
  return { v: 1, t: 'MED', g: 'JO62QM', s: 3, id: '80000001', ts: 1700000000, ...overrides };
}

/** Split a JSON payload into `parts` base64 chunks, the way a gateway receives them. */
function chunksOf(wire, parts = 2) {
  const bytes = Buffer.from(JSON.stringify(wire), 'utf8');
  const size = Math.ceil(bytes.length / parts);
  const out = [];
  for (let i = 0; i < parts; i++) {
    out.push(bytes.subarray(i * size, (i + 1) * size).toString('base64'));
  }
  return out;
}

function relayBody(chunkB64, fragIdx, fragCount, overrides = {}) {
  return {
    gatewayId: 'gw-1',
    band: 'ham',
    msgId: MSG_ID,
    fragIdx,
    fragCount,
    chunkB64,
    ...overrides,
  };
}

function buildApp({ enabled } = {}) {
  const store = new DomainStore({ seed: false });
  const app = express();
  app.use(express.json());
  app.use('/api/radio', createRadioGatewayRouter({ store, enabled }));
  return { app, store };
}

describe('radio gateway — fragment reassembly and exactly-once dispatch (#939)', () => {
  it('holds a partial message, then opens one incident when the last fragment arrives', async () => {
    const { app, store } = buildApp();
    const [c0, c1] = chunksOf(hamWire());

    const first = await request(app).post('/api/radio/relay').send(relayBody(c0, 0, 2));
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ status: 'partial', received: 1, fragCount: 2 });

    const last = await request(app).post('/api/radio/relay').send(relayBody(c1, 1, 2));
    expect(last.status).toBe(201);
    expect(last.body).toEqual({ status: 'dispatched', incidentId: INCIDENT_ID });

    const incident = store.getIncident(INCIDENT_ID);
    expect(incident.priority).toBe('critical');
    expect(incident.status).toBe('open');
    expect(incident.location.lat).toBeCloseTo(52.52, 2);
    expect(incident.location.lng).toBeCloseTo(13.375, 2);
    expect(store.listActiveIncidents(10)).toHaveLength(1);
  });

  it('a re-relay of a completed message is a duplicate and opens nothing new', async () => {
    const { app, store } = buildApp();
    const [c0, c1] = chunksOf(hamWire());
    await request(app).post('/api/radio/relay').send(relayBody(c0, 0, 2));
    await request(app).post('/api/radio/relay').send(relayBody(c1, 1, 2));

    const again = await request(app).post('/api/radio/relay').send(relayBody(c0, 0, 2));

    expect(again.status).toBe(200);
    expect(again.body).toEqual({ status: 'duplicate', incidentId: INCIDENT_ID });
    expect(store.listActiveIncidents(10)).toHaveLength(1);
  });

  it('a duplicate fragment is acknowledged without corrupting the buffer', async () => {
    const { app } = buildApp();
    const [c0, c1] = chunksOf(hamWire());
    await request(app).post('/api/radio/relay').send(relayBody(c0, 0, 2));

    const dup = await request(app).post('/api/radio/relay').send(relayBody(c0, 0, 2));
    expect(dup.status).toBe(202);
    expect(dup.body.status).toBe('duplicate_fragment');

    const done = await request(app).post('/api/radio/relay').send(relayBody(c1, 1, 2));
    expect(done.status).toBe(201);
  });

  it('refuses a fragment whose fragCount disagrees with the message in progress', async () => {
    const { app } = buildApp();
    const [c0] = chunksOf(hamWire());
    await request(app).post('/api/radio/relay').send(relayBody(c0, 0, 2));

    const clash = await request(app).post('/api/radio/relay').send(relayBody(c0, 0, 3));
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('fragment_mismatch');
  });

  it('does not open a second incident when the id already exists in the store', async () => {
    const { app, store } = buildApp();
    store.createIncident({ id: INCIDENT_ID, location: { lat: 1, lng: 1 } });
    const [c0, c1] = chunksOf(hamWire());
    await request(app).post('/api/radio/relay').send(relayBody(c0, 0, 2));

    const res = await request(app).post('/api/radio/relay').send(relayBody(c1, 1, 2));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('duplicate');
    expect(store.listActiveIncidents(10)).toHaveLength(1);
  });
});

describe('radio gateway — band-plan enforcement on the server (#939)', () => {
  it('refuses a ham payload carrying a PII field, reporting the name but not the value', async () => {
    const { app, store } = buildApp();
    const leaked = hamWire({ phone: '+15551234567' });
    const [c0, c1] = chunksOf(leaked);
    await request(app).post('/api/radio/relay').send(relayBody(c0, 0, 2, { msgId: 7 }));

    const res = await request(app).post('/api/radio/relay').send(relayBody(c1, 1, 2, { msgId: 7 }));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('band_plan_violation');
    expect(res.body.reason).toBe('band_plan_pii');
    expect(res.body.fields).toContain('phone');
    expect(JSON.stringify(res.body)).not.toContain('5551234567');
    expect(store.listActiveIncidents(10)).toHaveLength(0);
  });

  it('refuses an email address smuggled into an allowed field', async () => {
    const { app, store } = buildApp();
    const [c0, c1] = chunksOf(hamWire({ to: 'a@b.com' }));
    await request(app).post('/api/radio/relay').send(relayBody(c0, 0, 2, { msgId: 8 }));

    const res = await request(app).post('/api/radio/relay').send(relayBody(c1, 1, 2, { msgId: 8 }));

    expect(res.status).toBe(422);
    expect(res.body.fields).toEqual(['to']);
    expect(store.listActiveIncidents(10)).toHaveLength(0);
  });

  it('refuses licensed-band relays: the gateway holds no key to open them', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/radio/relay')
      .send(relayBody('AAAA', 0, 1, { band: 'licensed' }));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('licensed_band_not_relayable');
  });

  it('rejects a fragment index outside its message', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/radio/relay').send(relayBody('AAAA', 2, 2));
    expect(res.status).toBe(422);
  });

  it('checkHamWire accepts a clean wire object and rejects non-objects and unknown fields', () => {
    expect(checkHamWire(hamWire()).ok).toBe(true);
    expect(checkHamWire('plain text')).toEqual({ ok: false, reason: 'not_an_object', fields: [] });
    const unknown = checkHamWire(hamWire({ colour: 'red' }));
    expect(unknown).toEqual({ ok: false, reason: 'unknown_field', fields: ['colour'] });
  });
});

describe('radio gateway — feature flag and grid decode', () => {
  it('returns 503 when the gateway is switched off', async () => {
    const { app } = buildApp({ enabled: () => false });
    const res = await request(app).post('/api/radio/relay').send(relayBody('AAAA', 0, 1));
    expect(res.status).toBe(503);
  });

  it('reads HELPHONE_RADIO_GATEWAY=off as disabled and anything else as enabled', () => {
    expect(radioGatewayEnabled({ HELPHONE_RADIO_GATEWAY: 'off' })).toBe(false);
    expect(radioGatewayEnabled({})).toBe(true);
    expect(radioGatewayEnabled({ HELPHONE_RADIO_GATEWAY: 'on' })).toBe(true);
  });

  it('decodes a Maidenhead square to its centre', () => {
    const c = gridSquareCenter('JO62QM');
    expect(c.lat).toBeCloseTo(52.5208, 3);
    expect(c.lng).toBeCloseTo(13.375, 3);
  });
});
