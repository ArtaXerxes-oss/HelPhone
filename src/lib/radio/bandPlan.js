/**
 * Band-plan compliance (ISP-135 §Spike / acceptance: ham mode transmits zero
 * PII; licensed mode encrypts with compact AEAD inside the MTU budget).
 *
 * - ham (Part 97): plaintext, minimal schema — triage code, 6-char Maidenhead
 *   grid, severity 1-3, short id, timestamp. Name/phone/notes/address/coords
 *   are redacted BEFORE fragmentation. Encrypted ham traffic is illegal in
 *   most amateur jurisdictions, so the redaction is enforced structurally:
 *   fields outside HAM_WIRE_FIELDS never reach the encoder.
 * - licensed (Part 90): full intent encrypted with AES-256-GCM
 *   (12B IV prefix) using the session key.
 */

import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  utf8Decode,
  utf8Encode,
} from "../field/crypto";

export const BAND_MODES = Object.freeze({ HAM: "ham", LICENSED: "licensed" });

/** The only fields permitted on amateur bands. */
export const HAM_WIRE_FIELDS = Object.freeze([
  "v",
  "t",
  "g",
  "s",
  "id",
  "ts",
  "from",
  "to",
]);

/** Anything here must never appear in a ham-mode frame. */
export const PII_FIELDS = Object.freeze([
  "name",
  "phone",
  "notes",
  "address",
  "contact",
  "lat",
  "lng",
  "lon",
  "wallet",
  "email",
  "nickname",
]);

const TRIAGE_CODES = Object.freeze({
  medical: "MED",
  fallen: "FAL",
  lost: "LOS",
  car: "CAR",
  danger: "UNF",
  unsafe: "UNF",
  other: "OTH",
});

export function triageCode(type) {
  return TRIAGE_CODES[type] || "OTH";
}

/** 6-character Maidenhead grid square (~0.5km precision — coarse on purpose). */
export function toGridSquare(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "AA00AA";
  const clampedLat = Math.max(-89.999999, Math.min(89.999999, lat));
  const normLng = ((((lng + 180) % 360) + 360) % 360) - 180;
  const adjLat = clampedLat + 90;
  const adjLng = normLng + 180;
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lonField = A[Math.floor(adjLng / 20) % 18];
  const latField = A[Math.floor(adjLat / 10) % 9];
  const lonSquare = Math.floor((adjLng % 20) / 2);
  const latSquare = Math.floor(adjLat % 10);
  const lonSub = A[Math.floor((adjLng % 2) * 12) % 24];
  const latSub = A[Math.floor((adjLat % 1) * 24) % 24];
  return `${lonField}${latField}${lonSquare}${latSquare}${lonSub}${latSub}`;
}

/**
 * Reduce an intent to the ham-safe minimal schema.
 * @returns {{wire: object, redacted: string[]}}
 */
export function redactForHam(intent = {}, { from = "", to = "" } = {}) {
  const redacted = [];
  for (const field of PII_FIELDS) {
    if (intent[field] !== undefined && intent[field] !== null)
      redacted.push(field);
  }
  if (intent.notes !== undefined) redacted.push("notes");
  const lat = Number.isFinite(intent.lat) ? intent.lat : Number(intent.lat);
  const lng = Number.isFinite(intent.lng) ? intent.lng : Number(intent.lng);
  const wire = {
    v: 1,
    t: triageCode(intent.type || intent.t),
    g: toGridSquare(lat, lng),
    s: clampSeverity(intent.severity),
    id: String(intent.id ?? intent.requestId ?? "0").slice(0, 12),
    ts: Math.floor((intent.ts || Date.now()) / 1000),
  };
  if (from) wire.from = String(from).slice(0, 9);
  if (to) wire.to = String(to).slice(0, 9);
  return { wire, redacted: [...new Set(redacted)] };
}

function clampSeverity(severity) {
  const n = Number(severity);
  if (!Number.isFinite(n)) return 2;
  return Math.max(1, Math.min(3, Math.round(n)));
}

/** Licensed-band wire bytes: AES-256-GCM over compact JSON (iv||ct||tag). */
export async function encryptLicensed(intent, keyBytes) {
  const body = JSON.stringify({ v: 1, ts: Date.now(), ...intent });
  return aesGcmEncrypt(keyBytes, body);
}

export async function decryptLicensed(blob, keyBytes) {
  const plain = await aesGcmDecrypt(keyBytes, blob);
  return JSON.parse(utf8Decode(plain));
}

/**
 * Encode an intent for the selected band. Ham mode returns plaintext JSON
 * bytes of the redacted schema; licensed mode returns opaque AEAD bytes.
 */
export async function toWire(intent, mode, keyBytes, opts = {}) {
  if (mode === BAND_MODES.LICENSED) {
    if (!keyBytes) throw new Error("licensed band requires a session key");
    return {
      bytes: await encryptLicensed(intent, keyBytes),
      mode,
      redacted: [],
    };
  }
  const { wire, redacted } = redactForHam(intent, opts);
  return {
    bytes: utf8Encode(JSON.stringify(wire)),
    mode: BAND_MODES.HAM,
    redacted,
  };
}

export async function fromWire(bytes, mode, keyBytes) {
  if (mode === BAND_MODES.LICENSED) return decryptLicensed(bytes, keyBytes);
  return JSON.parse(utf8Decode(bytes));
}

/** Test/CI guard: throw if any PII field survives in a ham wire object. */
export function assertHamSafe(wireObject) {
  const leaks = Object.keys(wireObject).filter((k) => PII_FIELDS.includes(k));
  if (leaks.length > 0) {
    throw new Error(`ham band PII leak: ${leaks.join(", ")}`);
  }
  return true;
}
