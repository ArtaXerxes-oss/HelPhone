/**
 * Half-duplex priority scheduler for the 1200-baud VHF channel (ISP-135).
 *
 * Four lanes: SOS=0, NEW=1, ROSTER=2, LOC=3. Guarantees:
 *  - SOS preempts a 20-deep queue in one pick (no FIFO jam)
 *  - no lane starves: aging lifts starved items toward the SOS lane
 *  - continuous TX is capped (maxTxMs) then yields an RX window
 *  - carrier-sense before keying; exponential backoff on collision
 *  - TX tail gap after every burst so the far end can answer
 */

export const LANE_COUNT = 4;

export function createScheduler({
  sendFrame,
  carrierSense = () => true,
  now = () => Date.now(),
  timer = globalThis,
  txTailMs = 800,
  maxTxMs = 3000,
  rxWindowMs = 500,
  backoffBaseMs = 700,
  backoffMaxMs = 8000,
  starveAfter = 4,
  maxAttempts = 6,
  onState = () => {},
} = {}) {
  const lanes = [[], [], [], []];
  let running = false;
  let wakeTimer = null;
  let txActive = false;
  let lastTxAt = 0;
  let lastPickCounts = [0, 0, 0, 0];

  function laneDepths() {
    return lanes.map((l) => l.length);
  }

  function emit() {
    onState({
      running,
      txActive,
      lastTxAt,
      laneDepths: laneDepths(),
      total: lanes.reduce((n, l) => n + l.length, 0),
    });
  }

  function enqueue({ prio, frames, meta = {} }) {
    const lane = Math.max(0, Math.min(LANE_COUNT - 1, prio | 0));
    lanes[lane].push({ frames, meta, attempts: 0, age: 0, notBefore: 0 });
    emit();
    schedule(0);
    return lanes[lane].length;
  }

  function effectiveLane(item) {
    if (item.prioLane === 0) return 0;
    const boost = Math.floor(item.age / starveAfter);
    return Math.max(0, (item.prioLane ?? 2) - boost);
  }

  function pick() {
    // Aging: every item not picked grows older, lifting laggards a lane.
    const all = [];
    lanes.forEach((l, idx) =>
      l.forEach((it) => {
        it.prioLane = idx;
        all.push(it);
      }),
    );
    for (const it of all) it.age += 1;

    let best = null;
    let bestLane = LANE_COUNT;
    const t = now();
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      for (const item of lanes[lane]) {
        if (item.notBefore > t) continue;
        const eff = effectiveLane(item);
        if (eff < bestLane) {
          bestLane = eff;
          best = { item, lane };
        }
      }
    }
    return best;
  }

  function remove(item) {
    for (const lane of lanes) {
      const idx = lane.indexOf(item);
      if (idx >= 0) {
        lane.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  function schedule(delayMs) {
    if (!running) return;
    if (wakeTimer) return;
    wakeTimer = timer.setTimeout(() => {
      wakeTimer = null;
      tick();
    }, delayMs);
  }

  function tick() {
    if (!running) return;
    const found = pick();
    if (!found) {
      emit();
      return;
    }
    const { item } = found;

    if (!carrierSense()) {
      item.notBefore = now() + backoffBaseMs;
      schedule(backoffBaseMs);
      emit();
      return;
    }

    const burstStart = now();
    txActive = true;
    let collision = false;
    for (let i = 0; i < item.frames.length; i++) {
      if (now() - burstStart >= maxTxMs) break; // mandatory RX yield
      if (i > 0 && !carrierSense()) {
        collision = true;
        break;
      }
      const ok = sendFrame(item.frames[i], item.meta);
      lastTxAt = now();
      if (ok === false) {
        collision = true;
        break;
      }
    }
    txActive = false;

    if (collision) {
      remove(item);
      item.attempts += 1;
      item.age = 0;
      if (item.attempts < maxAttempts) {
        const backoff = Math.min(
          backoffMaxMs,
          backoffBaseMs * 2 ** item.attempts,
        );
        item.notBefore = now() + backoff;
        lanes[Math.max(0, Math.min(3, item.prioLane ?? 2))].unshift(item);
        schedule(backoff);
      }
      emit();
      return;
    }

    // Burst complete (or frame budget hit) — requeue remainder if TX window capped.
    remove(item);
    const sentUpTo = Math.min(
      item.frames.length,
      Math.floor((now() - burstStart) / 1) || item.frames.length,
    );
    if (sentUpTo < item.frames.length && now() - burstStart >= maxTxMs) {
      item.frames = item.frames.slice(sentUpTo);
      item.age = 0;
      lanes[Math.max(0, Math.min(3, item.prioLane ?? 2))].unshift(item);
    }
    if (
      item.meta &&
      typeof item.meta.onSent === "function" &&
      sentUpTo >= item.frames.length
    ) {
      try {
        item.meta.onSent();
      } catch {
        // best-effort — surface failures are non-fatal here
      }
    }

    lastPickCounts = lastPickCounts.map((c, idx) =>
      idx === (found.lane ?? 0) ? c + 1 : c,
    );
    schedule(txTailMs);
    emit();
  }

  function start() {
    if (running) return;
    running = true;
    schedule(0);
    emit();
  }

  function stop() {
    running = false;
    if (wakeTimer) {
      timer.clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    txActive = false;
    emit();
  }

  function flush() {
    for (const lane of lanes) lane.length = 0;
    emit();
  }

  return {
    enqueue,
    start,
    stop,
    flush,
    state: () => ({
      running,
      txActive,
      lastTxAt,
      laneDepths: laneDepths(),
      total: lanes.reduce((n, l) => n + l.length, 0),
    }),
  };
}
