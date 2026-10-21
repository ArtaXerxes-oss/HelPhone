import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduler } from "../src/lib/radio/scheduler";

describe("half-duplex priority scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeFrames(tag, n = 1) {
    return Array.from({ length: n }, (_, i) => Uint8Array.from([tag, i]));
  }

  it("SOS preempts a 20-deep location-delta queue on the very next pick", () => {
    const sent = [];
    const scheduler = createScheduler({
      sendFrame: (frame) => {
        sent.push(frame[0]);
        return true;
      },
      txTailMs: 10,
    });
    scheduler.start();
    for (let i = 0; i < 20; i++) {
      scheduler.enqueue({ prio: 3, frames: makeFrames(3), meta: { i } });
    }
    scheduler.enqueue({ prio: 0, frames: makeFrames(0), meta: { sos: true } });
    vi.advanceTimersByTime(50);
    expect(sent[0]).toBe(0); // SOS lane drained first
    scheduler.stop();
  });

  it("caps continuous TX at maxTxMs then yields", () => {
    let burstStart = null;
    let overruns = 0;
    const scheduler = createScheduler({
      sendFrame: () => {
        if (burstStart === null) burstStart = Date.now();
        if (Date.now() - burstStart > 3000) overruns++;
        return true;
      },
      maxTxMs: 3000,
      txTailMs: 10,
      carrierSense: () => true,
    });
    scheduler.start();
    scheduler.enqueue({ prio: 1, frames: makeFrames(1, 2000), meta: {} });
    vi.advanceTimersByTime(60000);
    expect(overruns).toBe(0);
    scheduler.stop();
  });

  it("waits out the carrier before keying (backoff on busy channel)", () => {
    const sent = [];
    let busy = true;
    const scheduler = createScheduler({
      sendFrame: (f) => {
        sent.push(f[0]);
        return true;
      },
      carrierSense: () => !busy,
      backoffBaseMs: 100,
      txTailMs: 10,
    });
    scheduler.start();
    scheduler.enqueue({ prio: 1, frames: makeFrames(1), meta: {} });
    vi.advanceTimersByTime(50);
    expect(sent).toHaveLength(0); // channel busy — nothing keyed
    busy = false;
    vi.advanceTimersByTime(500);
    expect(sent).toHaveLength(1);
    scheduler.stop();
  });

  it("requeues on collision with exponential backoff and eventually sends", () => {
    const sent = [];
    let collisions = 2;
    const scheduler = createScheduler({
      sendFrame: () => {
        if (collisions > 0) {
          collisions--;
          return false;
        }
        sent.push("ok");
        return true;
      },
      backoffBaseMs: 50,
      txTailMs: 5,
    });
    scheduler.start();
    scheduler.enqueue({ prio: 1, frames: makeFrames(1), meta: {} });
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual(["ok"]);
    scheduler.stop();
  });

  it("does not starve mid-priority lanes under a low-priority flood", () => {
    const lanesSeen = [];
    const scheduler = createScheduler({
      sendFrame: (frame) => {
        lanesSeen.push(frame[0]);
        return true;
      },
      starveAfter: 2,
      txTailMs: 1,
    });
    scheduler.start();
    // Flood lane 3, sprinkle lane 2 (roster).
    for (let i = 0; i < 30; i++) {
      scheduler.enqueue({ prio: 3, frames: makeFrames(3), meta: {} });
      if (i % 5 === 0)
        scheduler.enqueue({ prio: 2, frames: makeFrames(2), meta: {} });
    }
    vi.advanceTimersByTime(20000);
    const rosterServed = lanesSeen.filter((l) => l === 2).length;
    expect(rosterServed).toBeGreaterThanOrEqual(6); // aging lifted roster items
    scheduler.stop();
  });

  it("reports lane depths through onState", () => {
    const states = [];
    const scheduler = createScheduler({
      sendFrame: () => true,
      txTailMs: 100000, // hold queue visible
      onState: (s) => states.push(s),
    });
    scheduler.start();
    scheduler.enqueue({ prio: 0, frames: makeFrames(0), meta: {} });
    scheduler.enqueue({ prio: 3, frames: makeFrames(3), meta: {} });
    const last = states[states.length - 1];
    expect(last.laneDepths[0] + last.laneDepths[3]).toBeGreaterThanOrEqual(1);
    scheduler.stop();
  });
});
