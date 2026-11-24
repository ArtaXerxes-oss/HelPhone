import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { __setRedisForTests } from '../lib/redis.js';
import { consumeChallenge, saveChallenge } from '../routes/passkey-auth.js';

afterEach(() => __setRedisForTests(null));

test('passkey challenge can be consumed once only', async () => {
  __setRedisForTests(null);
  await saveChallenge('one-time-test-challenge', { kind: 'login' });
  assert.equal((await consumeChallenge('one-time-test-challenge')).kind, 'login');
  assert.equal(await consumeChallenge('one-time-test-challenge'), null);
});

test('expired passkey challenges are rejected', async () => {
  __setRedisForTests(null);
  await saveChallenge('expired-test-challenge', { kind: 'login' }, -1);
  assert.equal(await consumeChallenge('expired-test-challenge'), null);
});
