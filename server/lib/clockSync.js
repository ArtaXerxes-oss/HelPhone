/**
 * Clock-sync beacon (#794). Cristian's algorithm:
 *
 *   client sends t0 (client clock) → server stamps tServer → client receives at t1
 *   offset   = tServer - (t0 + t1) / 2      (add to client time to get server time)
 *   accuracy = ±(t1 - t0) / 2               (half the round trip)
 *
 * Several samples are taken and the one with the smallest RTT wins, since it
 * has the tightest bound.
 */

/** Express handler: GET /api/time → { tServer } stamped as late as possible. */
export function clockSyncHandler(_req, res) {
  res.set("Cache-Control", "no-store");
  res.set("Server-Timing", `clock;desc="${Date.now()}"`);
  res.json({ tServer: Date.now() });
}

export function estimateOffset(samples) {
  const valid = (samples || []).filter(
    (s) => Number.isFinite(s?.t0) && Number.isFinite(s?.t1) && Number.isFinite(s?.tServer) && s.t1 >= s.t0,
  );
  if (!valid.length) return null;
  const best = valid.reduce((a, b) => (b.t1 - b.t0 < a.t1 - a.t0 ? b : a));
  const rtt = best.t1 - best.t0;
  return {
    offsetMs: Math.round(best.tServer - (best.t0 + best.t1) / 2),
    confidenceMs: Math.ceil(rtt / 2),
    rttMs: rtt,
    samples: valid.length,
  };
}
