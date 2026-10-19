import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getRedis } from './redis.js';

const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 60 * 60);
const RENEW_WINDOW_SECONDS = Number(process.env.SESSION_RENEW_WINDOW_SECONDS || 10 * 60);
const memorySessions = new Map();
const memoryRevoked = new Map();

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sessionSecret() {
  const secret = process.env.SESSION_SECRET || '';
  if (secret.length < 32) throw new Error('SESSION_SECRET must be configured with at least 32 characters');
  return secret;
}

function sign(unsigned) {
  return createHmac('sha256', sessionSecret()).update(unsigned).digest('base64url');
}

function secondsUntil(exp) {
  return Math.max(1, Math.ceil(exp - Date.now() / 1000));
}

async function sessionClient() {
  return getRedis();
}

async function saveSession(jti, claims) {
  const ttl = secondsUntil(claims.exp);
  const redis = await sessionClient();
  const value = JSON.stringify(claims);
  if (redis?.set) {
    await redis.set(`session:active:${jti}`, value, 'EX', ttl);
  } else {
    memorySessions.set(jti, { value, expiresAt: claims.exp * 1000 });
  }
}

export async function issueSession(userId, username, opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds || SESSION_TTL_SECONDS;
  const jti = opts.jti || randomBytes(18).toString('base64url');
  const claims = {
    sub: userId,
    username,
    // ISP-059 / #729: UV tier rides the session so downstream middleware can
    // gate sensitive actions and audit can attribute (user, uv_tier) without
    // a perpetual device fingerprint. Defaults true because sessions are only
    // minted after ceremonies that already require user verification.
    uv: opts.uv !== false,
    iat: now,
    exp: now + ttl,
    jti,
  };
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  const token = `${unsigned}.${sign(unsigned)}`;
  await saveSession(jti, claims);
  return token;
}

export async function verifySessionToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(unsigned), 'base64url');
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header.alg !== 'HS256' || !claims.sub || !claims.jti || !Number.isFinite(claims.exp)) return null;
  if (claims.exp <= Date.now() / 1000) return null;

  const redis = await sessionClient();
  if (redis?.get) {
    const stored = await redis.get(`session:active:${claims.jti}`);
    if (!stored) return null;
  } else {
    const stored = memorySessions.get(claims.jti);
    if (!stored || stored.expiresAt <= Date.now()) return null;
  }
  return claims;
}

export async function revokeSession(jti, exp) {
  if (!jti) return;
  const ttl = secondsUntil(exp || Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS);
  const redis = await sessionClient();
  if (redis?.set) {
    await redis.set(`session:revoked:${jti}`, '1', 'EX', ttl);
    if (redis.del) await redis.del(`session:active:${jti}`);
  } else {
    memoryRevoked.set(jti, Date.now() + ttl * 1000);
    memorySessions.delete(jti);
  }
}

export async function isSessionRevoked(jti) {
  if (!jti) return true;
  const redis = await sessionClient();
  if (redis?.get) return (await redis.get(`session:revoked:${jti}`)) === '1';
  const expiresAt = memoryRevoked.get(jti);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    memoryRevoked.delete(jti);
    return false;
  }
  return true;
}

export async function renewSessionIfNeeded(token, claims) {
  const remaining = claims.exp - Math.floor(Date.now() / 1000);
  if (remaining > RENEW_WINDOW_SECONDS) return null;
  await revokeSession(claims.jti, claims.exp);
  return {
    token: await issueSession(claims.sub, claims.username, { uv: claims.uv !== false }),
    previousToken: token,
  };
}

export async function __resetSessionsForTests() {
  memorySessions.clear();
  memoryRevoked.clear();
}
