/**
 * Persistent offline outbox (localStorage-backed) with priority lanes,
 * idempotency keys, boundary PII redaction, PBKDF2/AES-GCM encryption at rest,
 * and bounded retention with purge auditing (#942).
 *
 * Shared by the radio bridge (ISP-135), NFC check-in (ISP-134) and hardware
 * SOS (ISP-131) so an intent created without network drains exactly once when
 * any transport returns.
 */

import { PII_FIELDS } from "../radio/bandPlan.js";
import { deriveKey, deriveStorageKey, PBKDF2_SALT_BYTES } from "../pbkdf2Key";
import { admitClaim } from "../sessionGenerations";

const STORAGE_KEY = "hp_offline_queue";
const SALT_STORAGE_KEY = "hp_offline_queue_salt";
const ENCRYPTED_VERSION = 2;

export const DEFAULT_MAX_QUEUE_ITEMS = 200;
export const DEFAULT_MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_AUDIT_ENTRIES = 50;

const EXTRA_SENSITIVE_FIELDS = Object.freeze([
  "secret",
  "token",
  "password",
  "privateKey",
  "seed",
  "mnemonic",
  "ssn",
  "dob",
]);

const REDACTED_FIELD_SET = new Set([...PII_FIELDS, ...EXTRA_SENSITIVE_FIELDS]);
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/;

/** Priority lanes — lower value drains first (SOS preempts everything). */
export const PRIO = Object.freeze({ SOS: 0, NEW: 1, ROSTER: 2, LOC: 3 });

let seqCounter = 0;
let activeKey = null;
let memoryState = null;
let pendingPersist = Promise.resolve();
let retentionConfig = {
  maxItems: DEFAULT_MAX_QUEUE_ITEMS,
  maxAgeMs: DEFAULT_MAX_RETENTION_MS,
};

const toBase64 = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const fromBase64 = (b64) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * Recursively redact PII and secret fields at the queue API boundary.
 * Returns { redactedData, redactedFields }.
 */
export function redactPayload(value, path = "", redactedFields = []) {
  if (value === null || value === undefined) {
    return { redactedData: value, redactedFields };
  }
  if (typeof value === "string") {
    if (EMAIL_RE.test(value) || PHONE_RE.test(value)) {
      if (path) redactedFields.push(path);
      return { redactedData: "[REDACTED]", redactedFields };
    }
    return { redactedData: value, redactedFields };
  }
  if (Array.isArray(value)) {
    const out = value.map((item, idx) =>
      redactPayload(item, `${path}[${idx}]`, redactedFields).redactedData,
    );
    return { redactedData: out, redactedFields };
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const nextPath = path ? `${path}.${k}` : k;
      if (REDACTED_FIELD_SET.has(k)) {
        if (v !== undefined && v !== null) redactedFields.push(nextPath);
        continue;
      }
      out[k] = redactPayload(v, nextPath, redactedFields).redactedData;
    }
    return { redactedData: out, redactedFields };
  }
  return { redactedData: value, redactedFields };
}

/**
 * Scrape raw outbox storage text for any plaintext PII fields or patterns.
 * Returns { clean: boolean, findings: string[] }.
 */
export function scanOutboxForPii(rawText) {
  const findings = [];
  if (!rawText || typeof rawText !== "string") return { clean: true, findings };

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { clean: true, findings };
  }

  // Encrypted envelope has no plaintext items.
  if (parsed && parsed.v === ENCRYPTED_VERSION && parsed.ct && !parsed.items) {
    return { clean: true, findings };
  }

  const walk = (node, p = "") => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      if (EMAIL_RE.test(node) || PHONE_RE.test(node)) {
        findings.push(`pii-pattern:${p || "root"}`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${p}[${i}]`));
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        const next = p ? `${p}.${k}` : k;
        if (REDACTED_FIELD_SET.has(k) && v !== undefined && v !== null) {
          findings.push(`pii-field:${next}`);
        } else {
          walk(v, next);
        }
      }
    }
  };

  walk(parsed?.items ?? parsed, "items");
  return { clean: findings.length === 0, findings };
}

function emptyState() {
  return { seq: 0, items: [], retentionAudit: [] };
}

function recordAudit(state, reason, purgedIds, now) {
  if (!Array.isArray(state.retentionAudit)) state.retentionAudit = [];
  if (purgedIds.length === 0 && reason !== "manual_clear") return;
  state.retentionAudit.push({
    at: now,
    reason,
    purgedCount: purgedIds.length,
    purgedIds,
    remaining: state.items.length,
  });
  if (state.retentionAudit.length > MAX_AUDIT_ENTRIES) {
    state.retentionAudit = state.retentionAudit.slice(-MAX_AUDIT_ENTRIES);
  }
}

function enforceRetention(state, { maxItems, maxAgeMs, now = Date.now() } = {}) {
  const cap = maxItems ?? retentionConfig.maxItems;
  const ttl = maxAgeMs ?? retentionConfig.maxAgeMs;
  const expiredIds = [];
  const kept = [];

  for (const item of state.items) {
    if (typeof item.createdAt === "number" && now - item.createdAt > ttl) {
      expiredIds.push(item.id);
    } else {
      kept.push(item);
    }
  }
  state.items = kept;
  if (expiredIds.length > 0) {
    recordAudit(state, "ttl_expired", expiredIds, now);
  }

  if (state.items.length > cap) {
    // Evict lowest-priority (highest prio number), oldest-seq items first.
    const byEvictionOrder = [...state.items].sort(
      (a, b) => b.prio - a.prio || a.seq - b.seq,
    );
    const excessCount = state.items.length - cap;
    const evictedIds = byEvictionOrder.slice(0, excessCount).map((i) => i.id);
    const evictedSet = new Set(evictedIds);
    state.items = state.items.filter((i) => !evictedSet.has(i.id));
    recordAudit(state, "capacity_exceeded", evictedIds, now);
  }
  return state;
}

async function encryptState(state, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(state));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain),
  );
  return JSON.stringify({
    v: ENCRYPTED_VERSION,
    alg: "AES-GCM",
    kdf: "PBKDF2",
    iv: toBase64(iv),
    ct: toBase64(ct),
  });
}

async function decryptState(raw, key) {
  const parsed = JSON.parse(raw);
  if (parsed?.v !== ENCRYPTED_VERSION || !parsed.iv || !parsed.ct) {
    return null;
  }
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(parsed.iv) },
    key,
    fromBase64(parsed.ct),
  );
  const decoded = JSON.parse(new TextDecoder().decode(plain));
  if (decoded && Array.isArray(decoded.items)) {
    return {
      seq: decoded.seq || 0,
      items: decoded.items,
      retentionAudit: Array.isArray(decoded.retentionAudit)
        ? decoded.retentionAudit
        : [],
    };
  }
  return emptyState();
}

async function deriveDeviceOutboxKey(passphrase) {
  if (typeof indexedDB !== "undefined") {
    try {
      return await deriveStorageKey(passphrase);
    } catch {
      // Fall back to localStorage-persisted random salt when IndexedDB is unavailable.
    }
  }
  let salt;
  const existing = localStorage.getItem(SALT_STORAGE_KEY);
  if (existing) {
    salt = fromBase64(existing);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
    localStorage.setItem(SALT_STORAGE_KEY, toBase64(salt));
  }
  return deriveKey(passphrase, salt);
}

/**
 * Derive the device PBKDF2 key, decrypt any existing encrypted outbox in
 * localStorage (surviving reload), and enable encrypted-at-rest persistence.
 */
export async function unlockOutbox(passphrase) {
  const key = await deriveDeviceOutboxKey(passphrase);
  activeKey = key;

  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (parsed?.v === ENCRYPTED_VERSION && parsed.iv && parsed.ct) {
      const decrypted = await decryptState(raw, key);
      if (decrypted) {
        seqCounter = Math.max(seqCounter, decrypted.seq || 0);
        memoryState = decrypted;
        return decrypted;
      }
    } else if (parsed && Array.isArray(parsed.items)) {
      // Migrate pre-unlock redacted entries into encrypted storage.
      const migrated = {
        seq: parsed.seq || 0,
        items: parsed.items.map((item) => ({
          ...item,
          data: redactPayload(item.data ?? {}).redactedData,
        })),
        retentionAudit: Array.isArray(parsed.retentionAudit)
          ? parsed.retentionAudit
          : [],
      };
      seqCounter = Math.max(seqCounter, migrated.seq || 0);
      memoryState = migrated;
      await flushOutboxPersistence(migrated);
      return migrated;
    }
  }

  if (!memoryState) memoryState = emptyState();
  await flushOutboxPersistence(memoryState);
  return memoryState;
}

/** Drop the in-memory key and cached plaintext state (e.g., to simulate reload). */
export function lockOutbox() {
  activeKey = null;
  memoryState = null;
}

export function isOutboxUnlocked() {
  return activeKey !== null;
}

export function configureRetention({ maxItems, maxAgeMs } = {}) {
  if (typeof maxItems === "number" && maxItems > 0) {
    retentionConfig.maxItems = maxItems;
  }
  if (typeof maxAgeMs === "number" && maxAgeMs > 0) {
    retentionConfig.maxAgeMs = maxAgeMs;
  }
}

export async function flushOutboxPersistence(stateOverride) {
  await pendingPersist;
  if (!activeKey) return;
  const target = stateOverride ?? memoryState ?? emptyState();
  const sealed = await encryptState(target, activeKey);
  localStorage.setItem(STORAGE_KEY, sealed);
}

function load() {
  if (memoryState) {
    seqCounter = Math.max(seqCounter, memoryState.seq || 0);
    return memoryState;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      memoryState = emptyState();
      return memoryState;
    }
    const v = JSON.parse(raw);
    if (v && Array.isArray(v.items)) {
      seqCounter = Math.max(seqCounter, v.seq || 0);
      memoryState = {
        seq: v.seq || 0,
        items: v.items,
        retentionAudit: Array.isArray(v.retentionAudit) ? v.retentionAudit : [],
      };
      return memoryState;
    }
  } catch {
    // best-effort — surface failures are non-fatal here
  }
  memoryState = emptyState();
  return memoryState;
}

function save(state) {
  memoryState = state;
  if (activeKey) {
    const snapshot = {
      seq: state.seq,
      items: [...state.items],
      retentionAudit: [...(state.retentionAudit || [])],
    };
    pendingPersist = pendingPersist
      .then(async () => {
        if (!activeKey) return;
        const sealed = await encryptState(snapshot, activeKey);
        localStorage.setItem(STORAGE_KEY, sealed);
      })
      .catch(() => {});
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // best-effort — surface failures are non-fatal here
  }
}

function nextSeq(state) {
  state.seq += 1;
  seqCounter = state.seq;
  return state.seq;
}

/**
 * Enqueue an intent. Enforces PII redaction at the API boundary, deduplicates
 * by idempotencyKey, and enforces bounded retention.
 * `session` (optional, #923): the SessionIdentity creating this intent. When
 * given, the write is refused unless that identity is the live generation, so
 * a revoked generation cannot accept new claims. Callers without a session
 * keep the previous behaviour.
 * @returns {{entry: object, duplicate: boolean, redactedFields: string[], refused?: string}}
 */
export function enqueue({ kind, prio = PRIO.NEW, idempotencyKey, data = {}, now = Date.now(), session = null }) {
  if (session) {
    const gate = admitClaim(session);
    if (!gate.ok) return { entry: null, duplicate: false, refused: gate.error, redactedFields: [] };
  }
  const state = load();
  enforceRetention(state, { now });

  if (idempotencyKey) {
    const existing = state.items.find(
      (i) => i.idempotencyKey === idempotencyKey,
    );
    if (existing) {
      return { entry: existing, duplicate: true, redactedFields: [] };
    }
  }

  const { redactedData, redactedFields } = redactPayload(data);
  const entry = {
    id: `q-${now.toString(36)}-${nextSeq(state).toString(36)}`,
    kind,
    prio: Math.max(0, Math.min(3, prio | 0)),
    idempotencyKey: idempotencyKey || null,
    data: redactedData,
    redactedFields,
    seq: state.seq,
    createdAt: now,
  };
  state.items.push(entry);
  enforceRetention(state, { now });
  save(state);
  return { entry, duplicate: false, redactedFields };
}

/** Queue ordered by priority lane, then insertion order. */
export function listQueue({ limit = 500 } = {}) {
  const state = load();
  return [...state.items]
    .sort((a, b) => a.prio - b.prio || a.seq - b.seq)
    .slice(0, limit);
}

export function removeEntry(id) {
  const state = load();
  const before = state.items.length;
  state.items = state.items.filter((i) => i.id !== id);
  save(state);
  return state.items.length < before;
}

export function clearQueue() {
  const prev = load();
  const purgedIds = prev.items.map((i) => i.id);
  const next = {
    seq: prev.seq,
    items: [],
    retentionAudit: [...(prev.retentionAudit || [])],
  };
  if (purgedIds.length > 0) {
    recordAudit(next, "manual_clear", purgedIds, Date.now());
  }
  save(next);
}

export function purgeExpiredEntries(options = {}) {
  const state = load();
  enforceRetention(state, options);
  save(state);
  return getRetentionAudit();
}

export function getRetentionAudit() {
  return [...(load().retentionAudit || [])];
}

export function queueDepth() {
  return load().items.length;
}

export function queueByKind(kind) {
  return listQueue().filter((i) => i.kind === kind);
}

export function findByIdempotencyKey(key) {
  if (!key) return null;
  return load().items.find((i) => i.idempotencyKey === key) || null;
}
