// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  SecureStorage,
  getOperatorStorage,
  lockAllOperatorStorage,
  normalizeOperatorId,
} from '../src/lib/secureStorage.ts';
import { deriveStorageKey } from '../src/lib/pbkdf2Key.ts';
import {
  acknowledgeHandoff,
  attemptPinElevation,
  getKioskSession,
  isLimitedMode,
  lockKiosk,
  startKioskSession,
  wipeKioskSession,
} from '../src/lib/kioskSession.ts';

class MemoryStorage {
  #m = new Map();
  getItem(k) {
    return this.#m.has(k) ? this.#m.get(k) : null;
  }
  setItem(k, v) {
    this.#m.set(k, String(v));
  }
  removeItem(k) {
    this.#m.delete(k);
  }
}

describe('operator ids (#925)', () => {
  it('normalises to lower case and trims surrounding space', () => {
    expect(normalizeOperatorId('  Ana-01 ')).toBe('ana-01');
  });

  it('refuses ids that could carry a separator or path-like character', () => {
    expect(() => normalizeOperatorId('')).toThrow();
    expect(() => normalizeOperatorId('a')).toThrow();
    expect(() => normalizeOperatorId('../shift')).toThrow();
    expect(() => normalizeOperatorId('ana:ben')).toThrow();
    expect(() => normalizeOperatorId('a'.repeat(33))).toThrow();
  });
});

describe('per-operator encrypted namespaces (#925)', () => {
  it('an operator who knows the same passphrase cannot read the prior shift', async () => {
    const backing = new MemoryStorage();
    const ana = new SecureStorage(backing, 'ana-ns');
    await ana.unlock('shared-passphrase');
    await ana.setItem('handover', 'triage note from ana');

    const ben = new SecureStorage(backing, 'ben-ns');
    await ben.unlock('shared-passphrase');

    expect(await ben.getItem('handover')).toBeNull();
  });

  it('copying the ciphertext into another namespace still does not decrypt', async () => {
    const backing = new MemoryStorage();
    const ana = new SecureStorage(backing, 'ana-copy');
    await ana.unlock('shared-passphrase');
    await ana.setItem('handover', 'secret');

    backing.setItem(
      'hp_secure:op:ben-copy:handover',
      backing.getItem('hp_secure:op:ana-copy:handover'),
    );
    const ben = new SecureStorage(backing, 'ben-copy');
    await ben.unlock('shared-passphrase');

    await expect(ben.getItem('handover')).rejects.toThrow(/Could not decrypt/);
  });

  it('keeps the device-wide store format unchanged', async () => {
    const backing = new MemoryStorage();
    const device = new SecureStorage(backing);
    await device.unlock('pw');
    await device.setItem('profile', 'nickname=alice');
    expect(backing.getItem('hp_secure:profile')).not.toBeNull();
    expect(await device.getItem('profile')).toBe('nickname=alice');
  });

  it('derives a different storage key for each scope from the same passphrase', async () => {
    const iv = new Uint8Array(12);
    const plain = new TextEncoder().encode('x');
    const kAna = await deriveStorageKey('pw', 'ana-key');
    const kBen = await deriveStorageKey('pw', 'ben-key');
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kAna, plain);
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kBen, ct)).rejects.toThrow();
  });

  it('caches one store per operator and drops every key on lock', async () => {
    const backing = new MemoryStorage();
    const first = getOperatorStorage('lock-op', backing);
    expect(getOperatorStorage('LOCK-OP', backing)).toBe(first);

    await first.unlock('pw');
    expect(first.unlocked).toBe(true);
    expect(lockAllOperatorStorage()).toBeGreaterThanOrEqual(1);
    expect(first.unlocked).toBe(false);
    await expect(first.getItem('anything')).rejects.toThrow(/locked/);
  });
});

describe('kiosk operator sign-in, handoff and lock (#925)', () => {
  it('a different operator hands off: the previous operator keys are dropped and the notice shows', async () => {
    const backing = new MemoryStorage();
    startKioskSession('BRAVO', 'Shelter Bravo');
    expect(await attemptPinElevation('0000', 'hand-ana')).toBe('elevated');
    expect(getKioskSession().operatorId).toBe('hand-ana');

    const ana = getOperatorStorage('hand-ana', backing);
    await ana.unlock('pw');

    expect(await attemptPinElevation('0000', 'hand-ben')).toBe('elevated');
    expect(ana.unlocked).toBe(false);
    expect(getKioskSession().operatorId).toBe('hand-ben');
    expect(getKioskSession().handoffFrom).toBe('hand-ana');

    acknowledgeHandoff();
    expect(getKioskSession().handoffFrom).toBeNull();
  });

  it('the same operator signing in again is not a handoff', async () => {
    startKioskSession('BRAVO', 'Shelter Bravo');
    // Clear any notice left by the previous test's operator, so only this step is measured.
    await attemptPinElevation('0000', 'same-op');
    acknowledgeHandoff();
    await attemptPinElevation('0000', 'same-op');
    expect(getKioskSession().handoffFrom).toBeNull();
  });

  it('refuses an invalid operator id before the PIN is counted', async () => {
    startKioskSession('BRAVO', 'Shelter Bravo');
    expect(await attemptPinElevation('0000', 'A ')).toBe('invalid-operator');
    expect(getKioskSession().wrongPinCount).toBe(0);
    expect(getKioskSession().role).toBe('kiosk-anon');
  });

  it('manual lock demotes to limited mode and forgets the operator', async () => {
    startKioskSession('BRAVO', 'Shelter Bravo');
    await attemptPinElevation('0000', 'lock-me');
    expect(isLimitedMode()).toBe(false);

    lockKiosk();

    expect(isLimitedMode()).toBe(true);
    expect(getKioskSession().operatorId).toBeNull();
  });

  it('auto-lock wipe drops the operator key along with the session', async () => {
    const backing = new MemoryStorage();
    startKioskSession('BRAVO', 'Shelter Bravo');
    await attemptPinElevation('0000', 'wipe-me');
    const vault = getOperatorStorage('wipe-me', backing);
    await vault.unlock('pw');

    wipeKioskSession();

    expect(vault.unlocked).toBe(false);
    expect(getKioskSession()).toBeNull();
  });
});
