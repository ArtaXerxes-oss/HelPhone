import { useEffect, useState } from "react";
import { readReplicaLagHeader } from "../lib/replicaLag.js";

const POLL_MS = 15_000;

/**
 * Latest replica replay lag in milliseconds, or null until the first reading.
 *
 * Reads `X-Replica-Lag-Ms` from `/api/history/stats`. The history router sets
 * that header on every response, and the endpoint is cheap. A failed poll keeps
 * the last known value rather than clearing the badge.
 */
export function useReplicaLag({ enabled = true } = {}) {
  const [lagMs, setLagMs] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const base = import.meta.env?.VITE_API_BASE_URL ?? "";

    async function poll() {
      try {
        const res = await fetch(`${base}/api/history/stats`, { cache: "no-store" });
        const next = readReplicaLagHeader(res.headers);
        if (!cancelled && next !== null) setLagMs(next);
      } catch {
        // Keep the last reading. A network blip should not flip the badge.
      }
    }

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  return lagMs;
}
