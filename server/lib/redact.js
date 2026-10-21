/**
 * Single redaction contract for logs, traces, indexer rows and exports (#792).
 *
 * - phone / contact / name   → `hmac:<16 hex>` (HMAC-SHA256, PII_HMAC_SALT) so
 *   the same value joins across logs, traces and DB rows.
 * - lat / lng                → rounded to 3 decimals (~110 m, geohash-7 scale).
 * - notes / memo / free text → dropped, length kept for triage.
 *
 * Joins only hold when every sink uses the same salt; rotate it everywhere at
 * once (see docs/security-runbook.md).
 */
import { createHmac } from "node:crypto";

const PSEUDONYM_KEYS = new Set(["phone", "contact", "name", "nickname", "email", "caller_phone", "user.phone"]);
const FREE_TEXT_KEYS = new Set(["notes", "note", "memo", "description", "message_body", "dispatch.note"]);
const COORD_KEYS = new Set(["lat", "lng", "lon", "latitude", "longitude", "dispatch.lat", "dispatch.lng"]);
const E164_RE = /\+?\d[\d\s().-]{7,}\d/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function salt() {
  return process.env.PII_HMAC_SALT || "helphone-dev-salt-not-for-production";
}

export function pseudonymize(value) {
  if (value == null || value === "") return value;
  return `hmac:${createHmac("sha256", salt()).update(String(value).trim().toLowerCase()).digest("hex").slice(0, 16)}`;
}

export function coarsenCoord(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : undefined;
}

/** Scrub phone numbers and emails embedded in free-form strings. */
export function scrubText(text) {
  if (typeof text !== "string") return text;
  return text.replace(EMAIL_RE, "[email]").replace(E164_RE, (m) => (m.replace(/\D/g, "").length >= 9 ? "[phone]" : m));
}

function redactValue(key, value) {
  const k = key.toLowerCase();
  if (PSEUDONYM_KEYS.has(k)) return pseudonymize(value);
  if (FREE_TEXT_KEYS.has(k)) return value == null ? value : `[redacted:${String(value).length}]`;
  if (COORD_KEYS.has(k)) return coarsenCoord(value);
  return undefined;
}

/** Deep-copy `input` with PII fields redacted. Unknown strings are scrubbed. */
export function redactObject(input, depth = 0) {
  if (depth > 8) return "[truncated]";
  if (Array.isArray(input)) return input.map((v) => redactObject(v, depth + 1));
  if (typeof input === "string") return scrubText(input);
  if (!input || typeof input !== "object") return input;
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const redacted = redactValue(key, value);
    out[key] = redacted !== undefined || value == null ? redacted ?? value : redactObject(value, depth + 1);
  }
  return out;
}

/** Redact query-string values of a request URL (path is kept verbatim). */
export function redactUrl(url) {
  if (typeof url !== "string") return url;
  const q = url.indexOf("?");
  if (q === -1) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  const out = new URLSearchParams();
  for (const [key, value] of params) {
    const redacted = redactValue(key, value);
    out.append(key, String(redacted !== undefined ? redacted : scrubText(value)));
  }
  const qs = out.toString();
  return qs ? `${url.slice(0, q)}?${qs}` : url.slice(0, q);
}

/** Attribute allowlist for spans: drop user.* and anything not listed. */
const SPAN_ATTRIBUTE_ALLOW = /^(http\.|net\.|rpc\.|helphone\.(dispatch_id|geohex|phone_hmac)|stellar\.|service\.|error\.|otel\.)/;
export function filterSpanAttributes(attrs = {}) {
  const out = {};
  for (const [k, v] of Object.entries(attrs)) if (SPAN_ATTRIBUTE_ALLOW.test(k)) out[k] = typeof v === "string" ? scrubText(v) : v;
  return out;
}
