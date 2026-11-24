/**
 * Drain queued staging check-ins to the server authority (#940).
 *
 * Each queued check-in carries its signed staging payload. Every entry is
 * POSTed once to /api/staging/check-in, and the server answers with one of:
 *
 *   201 accepted   -> checked in; remove entry
 *   200 duplicate  -> already recorded (exactly-once); remove entry
 *   409 revoked    -> conflict: tag revoked; remove entry, surface to operator
 *   422 forged/stale/malformed -> conflict: rejected; remove entry, surface
 *   503 / 429 / 5xx / network error -> keep entry and stop; retried next trigger
 *
 * Why the payload is stored as bytes: the offline queue runs a phone-number
 * pattern over every string value, and that pattern rewrites digit runs such
 * as a hex nonce or a timestamp. Byte values are numbers, which the queue
 * leaves unchanged. The payload holds no PII (see staging tag schema), so the
 * byte form is the only thing that changes. Decode is exact.
 */

import { queueByKind, removeEntry } from "./offlineQueue";
import { currentOrigin, resolveEndpoint } from "../endpointDefaults";

const CONFLICT_OUTCOMES = new Set(["revoked", "forged", "stale", "malformed"]);

// Production drains to the deployed origin, never a loopback address (#927).
function resolveBase() {
  try {
    return resolveEndpoint(import.meta.env?.VITE_SERVER_URL, "", {
      isProd: import.meta.env?.PROD === true,
      origin: currentOrigin(),
    });
  } catch {
    return "";
  }
}

export function stagingEndpoint(base = resolveBase()) {
  return `${String(base).replace(/\/$/, "")}/api/staging/check-in`;
}

/** Store a signed payload string as a byte array (see module note). */
export function encodeStagingPayload(json) {
  return Array.from(new TextEncoder().encode(String(json)));
}

/** Inverse of encodeStagingPayload. Returns null for anything that is not a byte array. */
export function decodeStagingPayload(bytes) {
  if (!Array.isArray(bytes) || bytes.length === 0) return null;
  if (!bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return null;
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

async function readBody(response) {
  try {
    return typeof response?.json === "function" ? (await response.json()) ?? {} : {};
  } catch {
    return {};
  }
}

/**
 * Send every queued check-in once, in queue order, stopping at the first retryable failure.
 * @returns {Promise<{sent:number, duplicate:number, conflicts:Array<{entryId:string, stagingId:string|null, outcome:string}>, pending:number}>}
 */
export async function flushStagingQueue({
  fetcher = (url, init) => globalThis.fetch(url, init),
  base,
} = {}) {
  const url = stagingEndpoint(base);
  const entries = queueByKind("staging");
  const result = { sent: 0, duplicate: 0, conflicts: [], pending: 0 };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const payload = decodeStagingPayload(entry.data?.payloadBytes);
    if (!payload) {
      removeEntry(entry.id);
      result.conflicts.push({ entryId: entry.id, stagingId: entry.data?.stagingId ?? null, outcome: "malformed" });
      continue;
    }

    let response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload }),
      });
    } catch {
      result.pending = entries.length - i;
      break;
    }

    const status = response?.status ?? 0;
    if (status === 201) {
      removeEntry(entry.id);
      result.sent += 1;
    } else if (status === 200) {
      removeEntry(entry.id);
      result.duplicate += 1;
    } else if (status === 409 || status === 422) {
      const body = await readBody(response);
      const outcome = CONFLICT_OUTCOMES.has(body.outcome) ? body.outcome : status === 409 ? "revoked" : "forged";
      removeEntry(entry.id);
      result.conflicts.push({ entryId: entry.id, stagingId: body.stagingId ?? entry.data?.stagingId ?? null, outcome });
    } else {
      result.pending = entries.length - i;
      break;
    }
  }

  return result;
}
