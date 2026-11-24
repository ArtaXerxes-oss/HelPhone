import { useEffect, useState, useSyncExternalStore } from "react";
import {
  getRpcHealthSnapshot,
  probeRpcNow,
  startRpcMonitoring,
  stopRpcMonitoring,
  subscribeRpcHealth,
} from "../lib/rpcHealth";

/**
 * Live RPC health for UI status indicators (#539).
 *
 * Starts the estimator's periodic probing while at least one component is
 * mounted and returns the latest snapshot:
 *   { activeLabel, activeLatencyMs, quality: 'good'|'degraded'|'offline'|'unknown',
 *     endpoints: [{ label, latencyMs, healthy, active, primary, ... }] }
 * plus `refresh()` to probe immediately.
 */
let consumers = 0;

export function useNetworkQuality() {
  const [clock, setClock] = useState({ offsetMs: null, accuracyMs: null });
  const snapshot = useSyncExternalStore(
    subscribeRpcHealth,
    getRpcHealthSnapshot,
    getRpcHealthSnapshot,
  );

  useEffect(() => {
    consumers += 1;
    startRpcMonitoring();
    return () => {
      consumers -= 1;
      if (consumers === 0) stopRpcMonitoring();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const samples = [];
    Promise.all(Array.from({ length: 3 }, async () => {
      const t0 = Date.now();
      const response = await fetch("/api/time", { cache: "no-store" });
      const { tServer } = await response.json();
      const t1 = Date.now();
      samples.push({ t0, t1, tServer });
    })).then(() => {
      if (cancelled || !samples.length) return;
      const best = samples.reduce((a, b) => b.t1 - b.t0 < a.t1 - a.t0 ? b : a);
      setClock({
        offsetMs: Math.round(best.tServer - (best.t0 + best.t1) / 2),
        accuracyMs: Math.ceil((best.t1 - best.t0) / 2),
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return { ...snapshot, clockOffsetMs: clock.offsetMs, clockAccuracyMs: clock.accuracyMs, refresh: probeRpcNow };
}
