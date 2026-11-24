/**
 * Daily-rotated audit attribution for the contract event streamer (#926).
 *
 * An audit row may say which user did something, which UV tier the session
 * had, and which device class was used, without ever holding a perpetual join
 * key. The user is represented by an HMAC over (UTC day, user id): stable
 * within a day so an incident can be counted and joined, unlinkable across
 * days. The device ID never enters the row; only a coarse device class does.
 *
 * Same construction as the clone-attempt pseudonym (server/lib/cloneAttemptAudit.ts).
 */

import { createHmac } from "node:crypto";

export const ATTRIBUTION_SECRET_MIN_LENGTH = 32;
export const UV_TIERS = Object.freeze(["uv", "limited", "unknown"]);
export const DEVICE_CLASSES = Object.freeze(["low", "mid", "high"]);

/** UTC calendar day (YYYY-MM-DD) for an ISO string or Date. */
export function utcDay(at) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) throw new Error("attribution needs a valid timestamp");
  return date.toISOString().slice(0, 10);
}

/** Daily user hash. Stable within `day`, unlinkable across days without the secret. */
export function dailyUserHash(userId, day, secret) {
  if (typeof secret !== "string" || secret.length < ATTRIBUTION_SECRET_MIN_LENGTH) {
    throw new Error(`attribution secret must be at least ${ATTRIBUTION_SECRET_MIN_LENGTH} characters`);
  }
  const id = String(userId).trim().toUpperCase();
  if (!id) throw new Error("attribution needs a non-empty user id");
  return createHmac("sha256", secret).update(`${day}|${id}`).digest("base64url").slice(0, 16);
}

/** Map a session's UV claim to a tier. Anything other than an explicit true is "limited". */
export function uvTierOf(event) {
  if (event?.uv === true || event?.uvTier === "uv") return "uv";
  if (event?.uv === false || event?.uvTier === "limited") return "limited";
  return "unknown";
}

/** Only the coarse allowlisted class survives; any raw device identifier is dropped. */
export function deviceClassOf(event) {
  const raw = event?.deviceClass ?? event?.device_class;
  return DEVICE_CLASSES.includes(raw) ? raw : "unknown";
}

/** The raw user identity on an event, if any. Never written to an audit row. */
export function userIdOf(event) {
  const candidate = event?.userId ?? event?.user ?? event?.sub ?? event?.actor ?? event?.signer;
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

/**
 * Attribution fields for one event. `user_hash_per_day` is null when the event
 * names no user. Throws if the secret is missing or too short, so a deployment
 * cannot silently write unkeyed hashes.
 */
export function attributionFor(event, { secret, observedAt }) {
  const userId = userIdOf(event);
  return {
    user_hash_per_day: userId ? dailyUserHash(userId, utcDay(observedAt), secret) : null,
    uv_tier: uvTierOf(event),
    device_class: deviceClassOf(event),
  };
}
