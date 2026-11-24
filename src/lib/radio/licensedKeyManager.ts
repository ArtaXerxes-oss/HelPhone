import { SecureStorage } from '../secureStorage';

export interface LicensedKeyAuditEntry {
  action: 'provision' | 'rotate' | 'clear';
  keyId: string;
  at: number;
  actor: string;
}

const KEY_NAME = 'licensed_radio_session_key';
const AUDIT_NAME = 'licensed_radio_key_audit';

export function licensedKeyId(hex: string): string {
  let hash = 2166136261;
  for (let i = 0; i < hex.length; i++) {
    hash ^= hex.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `lk-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export class LicensedKeyManager {
  constructor(private storage: SecureStorage) {}

  async provision(hex: string, actor: string): Promise<void> {
    if (!/^([0-9a-fA-F]{64})$/.test(hex)) throw new Error('Licensed session key must be 32 bytes (64 hex characters)');
    await this.storage.setItem(KEY_NAME, hex.toLowerCase());
    await this.audit('provision', hex, actor);
  }

  async rotate(hex: string, actor: string): Promise<void> {
    await this.provision(hex, actor);
  }

  async get(): Promise<string | null> {
    return this.storage.getItem(KEY_NAME);
  }

  async clear(actor: string): Promise<void> {
    const old = await this.get();
    this.storage.removeItem(KEY_NAME);
    if (old) await this.audit('clear', old, actor);
  }

  async audit(action: LicensedKeyAuditEntry['action'], hex: string, actor: string): Promise<void> {
    const raw = await this.storage.getItem(AUDIT_NAME);
    let entries: LicensedKeyAuditEntry[] = [];
    if (raw) {
      try { entries = JSON.parse(raw); } catch { entries = []; }
    }
    entries.push({ action, keyId: licensedKeyId(hex), at: Date.now(), actor: actor.slice(0, 80) });
    await this.storage.setItem(AUDIT_NAME, JSON.stringify(entries.slice(-100)));
  }

  async getAudit(): Promise<LicensedKeyAuditEntry[]> {
    const raw = await this.storage.getItem(AUDIT_NAME);
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  }
}
