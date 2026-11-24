import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.ts';
import {
  API_VERSION_POLICY,
  negotiatePeerVersion,
} from '../server/middleware/apiVersion.ts';

describe('API Versioning & Deprecation Policy (#947)', () => {
  it('serves /api/v1/* and legacy /api/* side by side with Deprecation and Sunset headers', async () => {
    const app = createApp({ telemetry: false });

    const v1Res = await request(app).get('/api/v1/dispatch');
    expect(v1Res.status).toBe(200);
    expect(v1Res.headers['x-api-version']).toBe('v1');
    expect(v1Res.headers['x-api-supported-versions']).toContain('v1');
    expect(v1Res.headers['deprecation']).toBeUndefined();
    expect(v1Res.headers['sunset']).toBeUndefined();

    const v0Res = await request(app).get('/api/dispatch');
    expect(v0Res.status).toBe(200);
    expect(v0Res.headers['x-api-version']).toBe('v0');
    expect(v0Res.headers['deprecation']).toBe(API_VERSION_POLICY.unversionedDeprecatedAt);
    expect(v0Res.headers['sunset']).toBe(API_VERSION_POLICY.unversionedSunsetAt);
    expect(v0Res.headers['link']).toContain('rel="successor-version"');
  });

  it('keeps /graphql backward compatible with compatibility headers', async () => {
    const app = createApp({ telemetry: false });
    const res = await request(app)
      .post('/graphql')
      .send({ query: '{ __typename }' });

    expect(res.status).toBe(200);
    expect(res.headers['x-graphql-compatibility']).toBe('backward-compatible');
    expect(res.headers['x-api-version']).toBe('v1');
  });

  it('negotiates supported versions for federation peers and rejects unsupported versions', () => {
    expect(negotiatePeerVersion(undefined)).toMatchObject({
      ok: true,
      negotiatedVersion: 'v1',
    });
    expect(negotiatePeerVersion('v0')).toMatchObject({
      ok: true,
      negotiatedVersion: 'v0',
    });
    expect(negotiatePeerVersion('v0, v1')).toMatchObject({
      ok: true,
      negotiatedVersion: 'v1',
    });
    expect(negotiatePeerVersion('application/vnd.helphone.v1+json')).toMatchObject({
      ok: true,
      negotiatedVersion: 'v1',
    });
    expect(negotiatePeerVersion('v99')).toMatchObject({
      ok: false,
      negotiatedVersion: null,
    });
  });
});
