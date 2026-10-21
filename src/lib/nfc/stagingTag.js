/**
 * NFC staging check-in/out (ISP-134).
 *
 * Tag payload schema (mime x-helphone/staging): { v, stagingId, nonce, ts, hmac }
 * — staging ID + rotated HMAC only, zero PII on the air per privacy policy.
 * HMAC is verified OFFLINE against the session-derived staging secret, so a
 * cloned static tag without a fresh nonce+HMAC is rejected as tamper.
 *
 * checkInOut reducer is idempotent on (responderId, stagingId, direction)
 * with a debounce window; double-taps become duplicate_suppressed audit
 * marks, never a second roster slot.
 */

import { crc16, hmacSha256Hex, utf8Decode, utf8Encode } from "../field/crypto";

export const NDEF_MIME = "x-helphone/staging";
export const NDEF_TEXT_PREFIX = "x-helphone-staging:";
export const STAGING_DEBOUNCE_MS = 15000;
export const UNMATCHED_IN_ESCALATION_MS = 30 * 60 * 1000;

async function computeHmac(stagingId, nonce, ts, secretHex) {
  return hmacSha256Hex(secretHex, `${stagingId}.${nonce}.${ts}`);
}

/** Build the JSON payload stored in an NDEF record (provisioning flow). */
export async function buildStagingPayload({
  stagingId,
  secretHex,
  now = Date.now(),
  nonce,
}) {
  const ts = Math.floor(now / 1000);
  const n = nonce || randomNonce();
  const hmac = await computeHmac(stagingId, n, ts, secretHex);
  return JSON.stringify({ v: 1, stagingId, nonce: n, ts, hmac });
}

function randomNonce() {
  const b = new Uint8Array(8);
  (globalThis.crypto || {}).getRandomValues
    ? globalThis.crypto.getRandomValues(b)
    : b.forEach((_, i) => (b[i] = Math.floor(Math.random() * 256)));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify a staging payload offline.
 * @returns {Promise<{valid: boolean, reason?: string, record?: object}>}
 */
export async function verifyStagingPayload(
  payload,
  secretHex,
  { now = Date.now(), maxSkewSec = 86400 } = {},
) {
  let record;
  try {
    record = typeof payload === "string" ? JSON.parse(payload) : payload;
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (
    !record ||
    record.v !== 1 ||
    !record.stagingId ||
    !record.nonce ||
    !record.hmac
  ) {
    return { valid: false, reason: "schema" };
  }
  if (typeof record.ts === "number") {
    const skew = Math.abs(Math.floor(now / 1000) - record.ts);
    if (skew > maxSkewSec) return { valid: false, reason: "stale" };
  }
  const expected = await computeHmac(
    record.stagingId,
    record.nonce,
    record.ts,
    secretHex,
  );
  if (!timingSafeEqualHex(expected, record.hmac)) {
    return { valid: false, reason: "hmac" };
  }
  return { valid: true, record };
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 6-char fallback short code for tags/QR when Web NFC is absent. */
export function shortCodeFor(stagingId) {
  const c = crc16(utf8Encode(String(stagingId)));
  return (
    c.toString(36).toUpperCase().padStart(4, "0").slice(-4) +
    String(stagingId).slice(0, 2).toUpperCase()
  );
}

/** Registry maps fallback codes -> stagingId (provisioned at staging setup). */
export function createStagingRegistry() {
  const map = new Map();
  return {
    register(stagingId, code = shortCodeFor(stagingId)) {
      map.set(String(code).toUpperCase(), String(stagingId));
      return code;
    },
    resolve(code) {
      return (
        map.get(
          String(code || "")
            .trim()
            .toUpperCase(),
        ) || null
      );
    },
    size: () => map.size,
  };
}

/**
 * Idempotent check-in/out reducer with 15s debounce per
 * (responderId, stagingId, direction) and Lamport-ish ordering by ts.
 */
export function createCheckInOutStore({
  debounceMs = STAGING_DEBOUNCE_MS,
  now = () => Date.now(),
} = {}) {
  /** key `${responderId}:${stagingId}` -> { direction, lastAt, lastNonce, history } */
  const roster = new Map();
  const seenNonces = new Set();

  function checkInOut({
    responderId,
    stagingId,
    direction,
    nonce = null,
    ts = null,
  }) {
    if (
      !responderId ||
      !stagingId ||
      (direction !== "IN" && direction !== "OUT")
    ) {
      return { status: "rejected", reason: "schema" };
    }
    if (nonce) {
      if (seenNonces.has(nonce)) {
        return { status: "duplicate_suppressed", reason: "nonce" };
      }
      seenNonces.add(nonce);
      if (seenNonces.size > 2048)
        seenNonces.delete(seenNonces.values().next().value);
    }
    const key = `${responderId}:${stagingId}`;
    const t = ts ?? now();
    const prev = roster.get(key);
    if (prev && prev.direction === direction && t - prev.lastAt < debounceMs) {
      return {
        status: "duplicate_suppressed",
        reason: "debounce",
        entry: { ...prev, duplicate_suppressed: true },
      };
    }
    const entry = {
      responderId: String(responderId),
      stagingId: String(stagingId),
      direction,
      at: t,
      lastAt: t,
      nonce,
      duplicate_suppressed: false,
    };
    roster.set(key, entry);
    return { status: "accepted", entry };
  }

  function rosterList() {
    return [...roster.values()].sort((a, b) => b.at - a.at);
  }

  function headcount(stagingId) {
    return rosterList().filter(
      (e) => e.direction === "IN" && (!stagingId || e.stagingId === stagingId),
    ).length;
  }

  /** IN records with no OUT after `escalationMs` — demob liability signal. */
  function unmatchedIns({ escalationMs = UNMATCHED_IN_ESCALATION_MS } = {}) {
    const t = now();
    return rosterList().filter(
      (e) => e.direction === "IN" && t - e.at > escalationMs,
    );
  }

  return { checkInOut, roster: rosterList, headcount, unmatchedIns };
}
