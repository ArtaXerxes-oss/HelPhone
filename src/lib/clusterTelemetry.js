// Tiny ring-buffer telemetry sink for map clustering (ADR-008 follow-up 4).
// Backend selection and every fallback reason are recorded here so a user (or
// a test) can observe why WebGPU/Worker was skipped. No user location or raw
// point data is emitted — only aggregate counts and timings.

export const CLUSTER_TELEMETRY_EVENTS = Object.freeze([
  "cluster.backend.selected",
  "cluster.backend.failed",
  "cluster.update",
  "cluster.hit-test",
]);

export function createClusterTelemetry({
  historySize = 300,
  now = () => Date.now(),
  onEvent = null,
} = {}) {
  const events = [];
  return {
    record(event) {
      const safe = {
        type: event.type,
        at: event.at ?? now(),
        backend: event.backend ?? null,
        reason: typeof event.reason === "string" ? event.reason.slice(0, 300) : undefined,
        fallbackReasons: Array.isArray(event.fallbackReasons)
          ? event.fallbackReasons.map((r) => ({
              backend: r.backend,
              reason: String(r.reason ?? "").slice(0, 300),
            }))
          : [],
        points: Number.isFinite(event.points) ? event.points : undefined,
        clusters: Number.isFinite(event.clusters) ? event.clusters : undefined,
        timings: event.timings ?? null,
      };
      events.push(safe);
      if (events.length > historySize) events.shift();
      onEvent?.(safe);
      return safe;
    },
    history: () => events.slice(),
    drain: () => events.splice(0),
    clear: () => {
      events.length = 0;
    },
    /** Latest backend-selection event, for HUD / assertions. */
    latestSelection: () => [...events].reverse().find((e) => e.type === "cluster.backend.selected") ?? null,
  };
}

export const clusterTelemetry = createClusterTelemetry({
  onEvent: (event) => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("helphone:cluster-telemetry", { detail: event }));
    }
  },
});

if (typeof window !== "undefined") {
  window.__helphoneClusterTelemetry = clusterTelemetry;
}
