/**
 * Drain queued hardware-SOS intents to the server (#941).
 *
 * The offline queue keeps an SOS until a transport returns. This module is the
 * drain: each queued SOS is POSTed to /api/dispatch/sos with its idempotency
 * key, and the server answers with one of:
 *
 *   201 created / 200 duplicate  -> incident is open (or already was); remove entry
 *   202 needs_confirm            -> server declined auto-dispatch; remove entry
 *   400 / 422 invalid            -> retrying cannot succeed; remove entry
 *   network error / 5xx / 429    -> keep entry and stop; retried on next trigger
 *
 * Coordinates are never stored in the queue (boundary redaction strips lat/lng),
 * so the caller passes the device's current location at flush time.
 */

import { queueByKind, removeEntry } from "./offlineQueue";
import { currentOrigin, resolveEndpoint } from "../endpointDefaults";

// Production drains to the deployed origin, never a loopback address (#927).
function resolveBase() {
  try {
    return resolveEndpoint(import.meta.env?.VITE_SERVER_URL, "", {
      isProd: import.meta.env?.PROD === true,
      origin: currentOrigin(),
    });
  } catch {
    return ""; // same-origin path, never a loopback address
  }
}

export function sosEndpoint(base = resolveBase()) {
  return `${String(base).replace(/\/$/, "")}/api/dispatch/sos`;
}

function usableLocation(location) {
  if (!location) return undefined;
  const { lat, lng } = location;
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
}

/**
 * Send every queued SOS once, in queue order, stopping at the first retryable failure.
 * @returns {Promise<{sent:number, declined:number, rejected:number, pending:number}>}
 */
export async function flushSosQueue({
  fetcher = (url, init) => globalThis.fetch(url, init),
  base,
  location = null,
} = {}) {
  const url = sosEndpoint(base);
  const coords = usableLocation(location);
  const entries = queueByKind("sos");
  const result = { sent: 0, declined: 0, rejected: 0, pending: 0 };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry.idempotencyKey) {
      removeEntry(entry.id);
      result.rejected += 1;
      continue;
    }

    let response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: entry.idempotencyKey,
          source: String(entry.data?.source ?? "hardware").slice(0, 32),
          force: entry.data?.force === true,
          location: coords,
        }),
      });
    } catch {
      result.pending = entries.length - i;
      break;
    }

    const status = response?.status ?? 0;
    if (status === 200 || status === 201) {
      removeEntry(entry.id);
      result.sent += 1;
    } else if (status === 202) {
      removeEntry(entry.id);
      result.declined += 1;
    } else if (status === 400 || status === 422) {
      removeEntry(entry.id);
      result.rejected += 1;
    } else {
      result.pending = entries.length - i;
      break;
    }
  }

  return result;
}
