import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { authMiddleware } from '../middleware/auth.ts';
import { __resetSessionsForTests, issueSession, revokeSession } from '../lib/session-store.js';

const secret = 'test-session-secret-that-is-at-least-32-characters';
const previousSecret = process.env.SESSION_SECRET;
const previousRenewWindow = process.env.SESSION_RENEW_WINDOW_SECONDS;

function token(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

function responseStub() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

afterEach(() => {
  if (previousSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSecret;
  if (previousRenewWindow === undefined) delete process.env.SESSION_RENEW_WINDOW_SECONDS;
  else process.env.SESSION_RENEW_WINDOW_SECONDS = previousRenewWindow;
  return __resetSessionsForTests();
});

test('accepts a valid stored passkey session bearer token', async () => {
  process.env.SESSION_SECRET = secret;
  const signed = await issueSession('account-1', 'alice');
  const req = { header: (name) => name === 'Authorization' ? `Bearer ${signed}` : null };
  const res = responseStub();
  let called = false;
  await authMiddleware(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.authenticatedUser.id, 'account-1');
  assert.equal(req.authenticatedUser.username, 'alice');
});

test('accepts a legacy passkey session bearer token without a jti', async () => {
  process.env.SESSION_SECRET = secret;
  const req = { header: (name) => name === 'Authorization' ? `Bearer ${token({ sub: 'account-1', username: 'alice', exp: Math.floor(Date.now() / 1000) + 60 })}` : null };
  const res = responseStub();
  let called = false;
  await authMiddleware(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.authenticatedUser.id, 'account-1');
});

test('rejects a modified passkey session bearer token', async () => {
  process.env.SESSION_SECRET = secret;
  const signed = token({ sub: 'account-1', exp: Math.floor(Date.now() / 1000) + 60 });
  const tampered = `${signed.slice(0, -1)}${signed.endsWith('a') ? 'b' : 'a'}`;
  const req = { header: (name) => name === 'Authorization' ? `Bearer ${tampered}` : null };
  const res = responseStub();
  let called = false;
  await authMiddleware(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('rejects a revoked stored passkey session bearer token', async () => {
  process.env.SESSION_SECRET = secret;
  const signed = await issueSession('account-1', 'alice');
  const claims = JSON.parse(Buffer.from(signed.split('.')[1], 'base64url').toString('utf8'));
  await revokeSession(claims.jti, claims.exp);

  const req = { header: (name) => name === 'Authorization' ? `Bearer ${signed}` : null };
  const res = responseStub();
  let called = false;
  await authMiddleware(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('renews a stored session when it is inside the sliding window', async () => {
  process.env.SESSION_SECRET = secret;
  process.env.SESSION_RENEW_WINDOW_SECONDS = '600';
  const signed = await issueSession('account-1', 'alice', { ttlSeconds: 60 });
  const req = { header: (name) => name === 'Authorization' ? `Bearer ${signed}` : null };
  const res = responseStub();
  res.headers = {};
  res.setHeader = (name, value) => { res.headers[name] = value; };

  let called = false;
  await authMiddleware(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.ok(res.headers['X-Session-Renewal']);
  assert.notEqual(res.headers['X-Session-Renewal'], signed);
});
