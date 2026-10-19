import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { getRedis } from '../lib/redis.js';
import { issueSession, revokeSession, verifySessionToken } from '../lib/session-store.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const challenges = new Map();
const credentials = new Map();

function config() {
  if (process.env.NODE_ENV === 'production' && (!process.env.PASSKEY_RP_ID || !process.env.PASSKEY_ORIGIN)) {
    throw new Error('PASSKEY_RP_ID and PASSKEY_ORIGIN must be configured in production');
  }
  const rpID = process.env.PASSKEY_RP_ID || 'localhost';
  const expectedOrigin = process.env.PASSKEY_ORIGIN || `http://${rpID}:3000`;
  return { rpID, expectedOrigin, rpName: process.env.PASSKEY_RP_NAME || 'HelPhone' };
}

async function store() {
  const redis = await getRedis();
  if (!redis && process.env.NODE_ENV === 'production') throw new Error('REDIS_URL is required for passkey sessions in production');
  return redis;
}

export async function saveChallenge(challenge, value, ttlMs = CHALLENGE_TTL_MS) {
  const redis = await store();
  const entry = JSON.stringify({ ...value, expiresAt: Date.now() + ttlMs });
  if (redis) {
    if (!redis.set) throw new Error('Redis client does not support expiring passkey challenges');
    await redis.set(`passkey:challenge:${challenge}`, entry, 'EX', Math.max(1, Math.ceil(ttlMs / 1000)));
  }
  else challenges.set(challenge, entry);
}

export async function consumeChallenge(challenge) {
  const redis = await store();
  let value;
  if (redis) {
    if (!redis.getdel) throw new Error('Redis client does not support atomic passkey challenge consumption');
    value = await redis.getdel(`passkey:challenge:${challenge}`);
  } else {
    value = challenges.get(challenge);
    challenges.delete(challenge);
  }
  if (!value) return null;
  const parsed = JSON.parse(value);
  return parsed.expiresAt > Date.now() ? parsed : null;
}

async function saveCredential(id, credential) {
  const value = JSON.stringify({
    id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: credential.transports || [],
    deviceType: credential.deviceType,
    backedUp: credential.backedUp,
    userId: credential.userId,
    username: credential.username,
  });
  const redis = await store();
  if (redis) await redis.hset('passkey:credentials', id, value);
  else credentials.set(id, value);
}

async function getCredential(id) {
  const redis = await store();
  const value = redis ? await redis.hget('passkey:credentials', id) : credentials.get(id);
  if (!value) return null;
  const entry = JSON.parse(value);
  return { ...entry, publicKey: new Uint8Array(Buffer.from(entry.publicKey, 'base64url')) };
}

async function listCredentials() {
  const redis = await store();
  const values = redis ? Object.values(await redis.hgetall('passkey:credentials')) : [...credentials.values()];
  return values.map((value) => JSON.parse(value));
}

function requireSessionSecret() {
  if ((process.env.SESSION_SECRET || '').length < 32) throw new Error('SESSION_SECRET must be configured with at least 32 characters');
}

export function createPasskeyAuthRouter() {
  const router = Router();
  router.post('/register/options', async (req, res) => {
    try {
      requireSessionSecret();
      const username = String(req.body?.username || '').trim();
      const displayName = String(req.body?.displayName || username).trim();
      if (!/^[a-zA-Z0-9_.@-]{1,64}$/.test(username) || !displayName || displayName.length > 80) {
        return res.status(400).json({ error: 'Invalid account name' });
      }
      const { rpID, rpName } = config();
      const userId = randomBytes(24).toString('base64url');
      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userName: username,
        userDisplayName: displayName,
        userID: new Uint8Array(Buffer.from(userId)),
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: (await listCredentials()).filter((item) => item.username === username).map((item) => ({ id: item.id, transports: item.transports })),
      });
      await saveChallenge(options.challenge, { kind: 'register', userId, username });
      return res.json({ options });
    } catch (error) {
      return res.status(503).json({ error: error instanceof Error ? error.message : 'Passkey setup unavailable' });
    }
  });

  router.post('/register/verify', async (req, res) => {
    try {
      const challenge = String(req.body?.challenge || '');
      const state = await consumeChallenge(challenge);
      if (!state || state.kind !== 'register') return res.status(400).json({ error: 'Challenge expired or already used' });
      const verification = await verifyRegistrationResponse({
        response: req.body?.response,
        expectedChallenge: challenge,
        expectedOrigin: config().expectedOrigin,
        expectedRPID: config().rpID,
        requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo) return res.status(401).json({ error: 'Passkey registration was not verified' });
      const info = verification.registrationInfo;
      await saveCredential(info.credential.id, {
        ...info.credential,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        userId: state.userId,
        username: state.username,
        transports: req.body?.response?.response?.transports || [],
      });
      return res.json({ verified: true, sessionToken: await issueSession(state.userId, state.username, { uv: true }) });
    } catch (error) {
      return res.status(401).json({ error: error instanceof Error ? error.message : 'Passkey verification failed' });
    }
  });

  router.post('/login/options', async (req, res) => {
    try {
      requireSessionSecret();
      const username = req.body?.username ? String(req.body.username) : null;
      const known = await listCredentials();
      const allowed = username ? known.filter((credential) => credential.username === username) : known;
      const { rpID } = config();
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: 'required',
        ...(username ? { allowCredentials: allowed.map((credential) => ({ id: credential.id, transports: credential.transports })) } : {}),
      });
      if (username && !allowed.length) return res.status(404).json({ error: 'No passkey is registered for this account' });
      await saveChallenge(options.challenge, { kind: 'login', username });
      return res.json({ options });
    } catch (error) {
      return res.status(503).json({ error: error instanceof Error ? error.message : 'Passkey login unavailable' });
    }
  });

  router.post('/login/verify', async (req, res) => {
    try {
      const challenge = String(req.body?.challenge || '');
      const state = await consumeChallenge(challenge);
      if (!state || state.kind !== 'login') return res.status(400).json({ error: 'Challenge expired or already used' });
      const id = String(req.body?.response?.id || '');
      const stored = await getCredential(id);
      if (!stored || (state.username && stored.username !== state.username)) return res.status(401).json({ error: 'Unknown passkey' });
      const verification = await verifyAuthenticationResponse({
        response: req.body.response,
        expectedChallenge: challenge,
        expectedOrigin: config().expectedOrigin,
        expectedRPID: config().rpID,
        requireUserVerification: true,
        credential: { id: stored.id, publicKey: stored.publicKey, counter: stored.counter, transports: stored.transports },
      });
      if (!verification.verified) return res.status(401).json({ error: 'Passkey assertion was not verified' });
      stored.counter = verification.authenticationInfo.newCounter;
      await saveCredential(id, stored);
      // ISP-059 / #729: record the measured UV tier on the session. The
      // requireUserVerification gate above makes uv=true a precondition, but
      // the claim is taken from the authenticator's answer so it stays honest
      // if enforcement is ever relaxed to a step-up model.
      return res.json({ verified: true, sessionToken: await issueSession(stored.userId, stored.username, { uv: verification.authenticationInfo.userVerified !== false }) });
    } catch (error) {
      return res.status(401).json({ error: error instanceof Error ? error.message : 'Passkey verification failed' });
    }
  });

  router.post('/session/refresh', async (req, res) => {
    try {
      const token = String(req.body?.sessionToken || '').trim();
      const claims = await verifySessionToken(token);
      if (!claims) return res.status(401).json({ error: 'Expired or invalid passkey session' });
      await revokeSession(claims.jti, claims.exp);
      return res.json({ sessionToken: await issueSession(claims.sub, claims.username, { uv: claims.uv !== false }) });
    } catch (error) {
      return res.status(401).json({ error: error instanceof Error ? error.message : 'Passkey refresh failed' });
    }
  });

  router.post('/session/logout', async (req, res) => {
    try {
      const token = String(req.body?.sessionToken || '').trim();
      const claims = await verifySessionToken(token);
      if (claims) await revokeSession(claims.jti, claims.exp);
      return res.json({ revoked: true });
    } catch (error) {
      return res.status(401).json({ error: error instanceof Error ? error.message : 'Passkey logout failed' });
    }
  });
  return router;
}
