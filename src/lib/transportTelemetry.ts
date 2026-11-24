/**
 * Transport field telemetry — issue #913, ADR-003 follow-up 3.
 *
 * Reads the raw metrics snapshot from `createNetworkTransport().getMetrics()`
 * and emits a single bounded, PII-free span into the telemetry pipeline.
 *
 * Fields emitted:
 *   transport.reconnect_gaps_ms   — bounded array (≤ MAX_RECONNECT_GAPS) of
 *                                   gap durations in ms between disconnect and
 *                                   reconnect; feeds UDP-block-rate dashboard.
 *   transport.reconnect_gap_p50   — p50 of the gap array (0 when empty).
 *   transport.reconnect_gap_max   — max gap in ms (0 when empty).
 *   transport.fallbacks           — count of transport downgrades (WT→WS→SSE).
 *   transport.failures.webtransport — consecutive WebTransport failures;
 *                                   high values signal UDP-blocked networks.
 *   transport.migrations_survived — QUIC connection migration successes.
 *   transport.connects            — total successful connect events.
 *
 * Redaction rules (keep in sync with TelemetryRedactor):
 *   - No IP addresses, user IDs, or message content enter the span.
 *   - reconnect_gaps_ms is capped at MAX_RECONNECT_GAPS entries so a long
 *     session cannot grow the payload unboundedly.
 *   - Individual gap values are clamped to MAX_GAP_MS to prevent outlier
 *     values from fingerprinting a user's network event sequence.
 *   - failures.webtransport is capped at MAX_FAILURE_COUNT so an adversarial
 *     transport cannot encode bits in a large counter.
 */

import type { TelemetryPipeline } from './telemetry'

/** Maximum entries kept in the reconnect-gaps array per emission. */
export const MAX_RECONNECT_GAPS = 20

/** Maximum ms a single gap value may carry (caps outliers, ~8 min). */
export const MAX_GAP_MS = 5 * 60_000

/** Maximum value emitted for any failure counter. */
export const MAX_FAILURE_COUNT = 100

export interface TransportMetricsSnapshot {
  connects: number
  fallbacks: number
  reconnectGapsMs: number[]
  migrationsSurvived: number
  failures: { webtransport: number; websocket: number; sse: number }
  // remaining fields present in getMetrics() but not consumed here
  [key: string]: unknown
}

/**
 * Derive bounded, PII-free attributes from a raw metrics snapshot.
 * Pure — suitable for unit testing without a real pipeline.
 */
export function buildTransportAttributes(
  snapshot: TransportMetricsSnapshot,
): Record<string, unknown> {
  const gaps = snapshot.reconnectGapsMs
    .slice(-MAX_RECONNECT_GAPS)
    .map((v) => Math.min(v, MAX_GAP_MS))

  const p50 = percentile(gaps, 50)
  const gapMax = gaps.length > 0 ? Math.max(...gaps) : 0

  return {
    'transport.reconnect_gaps_ms': gaps,
    'transport.reconnect_gap_p50': p50,
    'transport.reconnect_gap_max': gapMax,
    'transport.fallbacks': snapshot.fallbacks,
    'transport.failures.webtransport': Math.min(
      snapshot.failures.webtransport,
      MAX_FAILURE_COUNT,
    ),
    'transport.migrations_survived': snapshot.migrationsSurvived,
    'transport.connects': snapshot.connects,
  }
}

/**
 * Emit a single transport-field telemetry span.
 *
 * Call this periodically (e.g. on page hide / visibility change) or after a
 * significant transport event such as a fallback or migration.
 *
 * Returns `true` when the span was accepted by the ring, `false` when the
 * pipeline dropped it (backpressure or sampler).
 */
export function emitTransportTelemetry(
  pipeline: TelemetryPipeline,
  snapshot: TransportMetricsSnapshot,
): boolean {
  return pipeline.record({
    name: 'transport.field_metrics',
    kind: 'measurement',
    priority: 'low',
    attributes: buildTransportAttributes(snapshot),
  })
}

// ── private helpers ───────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const asc = [...sorted].sort((a, b) => a - b)
  const idx = (p / 100) * (asc.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return lo === hi ? asc[lo] : asc[lo] + (asc[hi] - asc[lo]) * (idx - lo)
}
