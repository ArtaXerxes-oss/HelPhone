import { beforeEach, describe, expect, it } from "vitest";
import { classifyPress, sosIdempotencyKey } from "../src/hooks/useHardwareSOS";
import {
  PRIO,
  clearQueue,
  enqueue,
  findByIdempotencyKey,
  listQueue,
} from "../src/lib/field/offlineQueue";
import { statusCode, STATUS_CODES } from "../src/lib/field/statusCodes";
import {
  getTransport,
  transportBadge,
  TRANSPORTS,
} from "../src/lib/field/transportEstimator";

describe("hardware SOS press classifier", () => {
  it("commits only on a >=1.2s hold", () => {
    expect(classifyPress(1000, 1000 + 1200)).toBe("commit");
    expect(classifyPress(1000, 1000 + 2000)).toBe("commit");
  });

  it("treats short taps as PTT and micro-bounces as ignored (pocket press)", () => {
    expect(classifyPress(1000, 1000 + 150)).toBe("ptt");
    expect(classifyPress(1000, 1000 + 30)).toBe("ignored"); // glove bounce
    expect(classifyPress(1000, 1000 + 500)).toBe("ignored"); // ambiguous press
    expect(classifyPress(null, 1000)).toBe("ignored");
  });

  it("two presses inside the 10s dedupe window map to one idempotency key", () => {
    expect(sosIdempotencyKey(50_000)).toBe(sosIdempotencyKey(55_000));
    expect(sosIdempotencyKey(50_000)).not.toBe(sosIdempotencyKey(70_000));
  });
});

describe("SOS offline enqueue semantics", () => {
  beforeEach(() => {
    localStorage.clear();
    clearQueue();
  });

  it("an SOS queued offline drains-first and never duplicates", () => {
    enqueue({ kind: "loc", prio: PRIO.LOC, idempotencyKey: "loc-1" });
    enqueue({ kind: "loc", prio: PRIO.LOC, idempotencyKey: "loc-2" });
    const key = sosIdempotencyKey(60_000);
    const first = enqueue({
      kind: "sos",
      prio: PRIO.SOS,
      idempotencyKey: key,
      data: { source: "hardware-key" },
    });
    const second = enqueue({
      kind: "sos",
      prio: PRIO.SOS,
      idempotencyKey: key,
      data: { source: "hardware-key" },
    });
    expect(second.duplicate).toBe(true);
    expect(listQueue()[0].kind).toBe("sos");
    expect(findByIdempotencyKey(key).id).toBe(first.entry.id);
  });
});

describe("transport unification", () => {
  it("reports radio as a distinct transport, not offline", () => {
    expect(getTransport({ online: false, radioLinked: true })).toBe(
      TRANSPORTS.RADIO,
    );
    expect(getTransport({ online: true, radioLinked: false })).toBe(
      TRANSPORTS.WS,
    );
    expect(getTransport({ online: false, radioLinked: false })).toBe(
      TRANSPORTS.OFFLINE,
    );
    expect(transportBadge("radio").label).toMatch(/RADIO LINK/);
    expect(transportBadge("offline").label).toMatch(/will sync/);
  });
});

describe("compact 2-letter status codes", () => {
  it("maps statuses to wire codes", () => {
    expect(statusCode("sos")).toBe("S0");
    expect(statusCode("pending")).toBe("PD");
    expect(statusCode("stagedIn")).toBe("IN");
    expect(statusCode("nope")).toBe(STATUS_CODES.unknown);
  });
});
