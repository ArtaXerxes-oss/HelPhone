/**
 * Encrypted localStorage. Values are sealed with AES-256-GCM under a key
 * derived from the user's passphrase (see pbkdf2Key.ts), so nothing sensitive
 * sits in plaintext in browser storage.
 *
 * Stored format: JSON `{ v: 1, iv: <base64>, ct: <base64> }` under
 * `hp_secure:<key>`. AES-GCM authenticates the ciphertext, so a wrong
 * passphrase or a tampered value is rejected instead of yielding garbage.
 */
import { deriveStorageKey } from './pbkdf2Key';

const PREFIX = 'hp_secure:';
const VERSION = 1;

const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export class SecureStorage {
  private key: CryptoKey | null = null;

  /**
   * @param storage backing store (localStorage by default)
   * @param scope   operator namespace from normalizeOperatorId(), or '' for the
   *   device-wide store the app has always used. A scoped instance reads and
   *   writes only its own entries and derives a key other scopes cannot reproduce.
   */
  constructor(
    private readonly storage: Storage = globalThis.localStorage,
    private readonly scope = '',
  ) {}

  get namespace(): string {
    return this.scope;
  }

  get unlocked(): boolean {
    return this.key !== null;
  }

  /** Derive the key from a passphrase. Must be called before get/set. */
  async unlock(passphrase: string): Promise<void> {
    this.key = await deriveStorageKey(passphrase, this.scope);
  }

  private entryName(name: string): string {
    return this.scope ? `${PREFIX}op:${this.scope}:${name}` : PREFIX + name;
  }

  /** Drop the in-memory key. */
  lock(): void {
    this.key = null;
  }

  private requireKey(): CryptoKey {
    if (!this.key) throw new Error('Secure storage is locked');
    return this.key;
  }

  async setItem(name: string, value: string): Promise<void> {
    const key = this.requireKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value)),
    );
    this.storage.setItem(this.entryName(name), JSON.stringify({ v: VERSION, iv: toBase64(iv), ct: toBase64(ct) }));
  }

  /** Returns null if the entry is absent. Throws if it cannot be decrypted. */
  async getItem(name: string): Promise<string | null> {
    const key = this.requireKey();
    const raw = this.storage.getItem(this.entryName(name));
    if (raw === null) return null;
    let parsed: { v?: number; iv?: string; ct?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Secure storage entry is corrupted');
    }
    if (parsed.v !== VERSION || !parsed.iv || !parsed.ct) {
      throw new Error('Secure storage entry has an unsupported format');
    }
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(parsed.iv) as BufferSource },
        key,
        fromBase64(parsed.ct) as BufferSource,
      );
      return new TextDecoder().decode(plain);
    } catch {
      throw new Error('Could not decrypt secure storage entry (wrong passphrase or tampered data)');
    }
  }

  removeItem(name: string): void {
    this.storage.removeItem(this.entryName(name));
  }
}

const OPERATOR_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

/**
 * Normalise a shift operator's id into a storage namespace (#925). Ids are 2-32
 * characters of [a-z0-9-] after trimming and lower-casing. Anything else is refused,
 * so a namespace cannot carry a separator or path-like character.
 */
export function normalizeOperatorId(operatorId: string): string {
  const id = String(operatorId ?? '').trim().toLowerCase();
  if (!OPERATOR_ID_RE.test(id)) {
    throw new Error('Operator ID must be 2-32 characters: letters, digits or dashes');
  }
  return id;
}

const operatorVaults = new Map<string, SecureStorage>();

/**
 * The encrypted store for one operator. Instances are cached per operator, so
 * one unlock serves that operator's screens and lockAllOperatorStorage() drops it.
 */
export function getOperatorStorage(operatorId: string, backing: Storage = globalThis.localStorage): SecureStorage {
  const scope = normalizeOperatorId(operatorId);
  let vault = operatorVaults.get(scope);
  if (!vault) {
    vault = new SecureStorage(backing, scope);
    operatorVaults.set(scope, vault);
  }
  return vault;
}

/**
 * Drop every operator key from memory: on shift handoff, manual lock, or auto-lock.
 * Entries stay encrypted at rest. Returns how many were unlocked.
 */
export function lockAllOperatorStorage(): number {
  let unlocked = 0;
  for (const vault of operatorVaults.values()) {
    if (vault.unlocked) unlocked += 1;
    vault.lock();
  }
  return unlocked;
}

export interface JournalEntry {
  deviceId: string;
  seq: number;
  op: any;
  acked: boolean;
  timestamp: number;
}

export class JournalStore {
  private entries: JournalEntry[] = [];

  constructor(private readonly storage?: Storage) {
    this.load();
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem('hp_idb_journal');
      if (raw) this.entries = JSON.parse(raw);
    } catch {}
  }

  private save(): void {
    try {
      this.storage?.setItem('hp_idb_journal', JSON.stringify(this.entries));
    } catch {}
  }

  append(deviceId: string, seq: number, op: any): void {
    this.entries.push({
      deviceId,
      seq,
      op,
      acked: false,
      timestamp: Date.now(),
    });
    this.save();
  }

  markAcked(deviceId: string, seq: number): void {
    for (const e of this.entries) {
      if (e.deviceId === deviceId && e.seq <= seq) {
        e.acked = true;
      }
    }
    this.save();
  }

  getHighwater(deviceId?: string): number {
    let max = 0;
    for (const e of this.entries) {
      if (deviceId && e.deviceId !== deviceId) continue;
      if (e.seq > max) max = e.seq;
    }
    return max;
  }

  getUnackedEntries(aboveSeq = 0, deviceId?: string): JournalEntry[] {
    return this.entries.filter((e) => {
      if (deviceId && e.deviceId !== deviceId) return false;
      return e.seq > aboveSeq && !e.acked;
    });
  }

  getAllEntries(aboveSeq = 0, deviceId?: string): JournalEntry[] {
    return this.entries.filter((e) => {
      if (deviceId && e.deviceId !== deviceId) return false;
      return e.seq > aboveSeq;
    });
  }

  clear(): void {
    this.entries = [];
    this.save();
  }
}

let journalSingleton: JournalStore | null = null;
export function getJournalStore(storage?: Storage): JournalStore {
  if (!journalSingleton) {
    journalSingleton = new JournalStore(storage || (typeof localStorage !== 'undefined' ? localStorage : undefined));
  }
  return journalSingleton;
}

