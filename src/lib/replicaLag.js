/**
 * Replica lag helpers for the history UI (ISP-065, issue #934).
 *
 * The server reports replay lag on every history response in the
 * `X-Replica-Lag-Ms` header. These helpers turn that number into what the user
 * sees: a `⚠️ Stale ~Xs` badge once lag passes the 10 s budget, and a dispatch
 * confirmation once lag reaches the 30 s severe tier. Pure, so they can be unit
 * tested without a DOM or a server.
 */

export const REPLICA_LAG_BUDGET_MS = 10_000;
export const SEVERE_REPLICA_LAG_MS = 30_000;

/** Parses `X-Replica-Lag-Ms` from a Headers instance or a plain header object. Returns null when absent or invalid. */
export function readReplicaLagHeader(headers) {
  if (!headers) return null;
  const raw =
    typeof headers.get === "function"
      ? headers.get("X-Replica-Lag-Ms")
      : headers["x-replica-lag-ms"] ?? headers["X-Replica-Lag-Ms"];
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Badge text for lag above the budget, otherwise null (no badge). */
export function staleBadgeText(lagMs) {
  if (lagMs === null || lagMs === undefined || !(lagMs > REPLICA_LAG_BUDGET_MS)) return null;
  return `⚠️ Stale ~${Math.round(lagMs / 1000)}s`;
}

/** True in the severe tier. Dispatch then needs an explicit confirmation. */
export function requiresDispatchOverride(lagMs) {
  return lagMs !== null && lagMs !== undefined && lagMs > SEVERE_REPLICA_LAG_MS;
}

export function dispatchOverrideMessage(lagMs) {
  const seconds = Math.round((lagMs ?? 0) / 1000);
  return `Server history is about ${seconds} seconds behind the latest ledger, so responders may not see the newest activity. Dispatch anyway?`;
}
