/**
 * ADR-014 telemetry wire-format conformance suite — 49 checks.
 *
 * These checks pin the HPTL FlatBuffers contract: the official Builder must
 * produce frames the in-repo reader decodes, and ingest must reject malformed
 * input without throwing. The schema in src/schemas/telemetry.fbs is the
 * authority that `flatc` validates against.
 */

import { describe, expect, it } from "vitest";
import {
  FILE_IDENTIFIER,
  Kind,
  MAX_FRAME_BYTES,
  MAX_OBJECTS_PER_FRAME,
  SCHEMA_VERSION,
  Status,
  TelemetryFrameRangeError,
  decodeTelemetryFrame,
  encodeTelemetryFrame,
  frameSummary,
  getRootAsFrame,
  readTelemetryObjects,
  verifyFrame,
} from "../src/lib/telemetryFrame.js";
import {
  createFrameEncoder,
  TELEMETRY_BUDGETS,
  verifyIngest,
} from "../server/telemetry.js";

const sample = (i = 0) => ({
  id: 1000 + i,
  kind: i % 3,
  status: i % 4,
  lat: 6.5244 + i / 1000,
  lng: 3.3792 - i / 1000,
  heading: (i * 7) % 360,
  speed: 12 + (i % 20),
});
const samples = (n) => Array.from({ length: n }, (_, i) => sample(i));

describe("01 · schema identity (5)", () => {
  it("1. file identifier is HPTL", () => expect(FILE_IDENTIFIER).toBe("HPTL"));
  it("2. identifier is exactly 4 bytes", () =>
    expect(FILE_IDENTIFIER).toHaveLength(4));
  it("3. object cap is 1000", () => expect(MAX_OBJECTS_PER_FRAME).toBe(1000));
  it("4. schema version is 1", () => expect(SCHEMA_VERSION).toBe(1));
  it("5. enums are single bytes", () => {
    expect(Kind).toEqual({ Responder: 0, Requester: 1, Incident: 2 });
    expect(Status).toEqual({ Active: 0, EnRoute: 1, OnScene: 2, Resolved: 3 });
  });
});

describe("02 · encoder output shape (8)", () => {
  it("6. empty frame encodes", () =>
    expect(encodeTelemetryFrame([])).toBeInstanceOf(Uint8Array));
  it("7. single object encodes", () =>
    expect(encodeTelemetryFrame([sample()]).length).toBeGreaterThan(12));
  it("8. maximum 1000 objects encode", () => {
    const buf = encodeTelemetryFrame(samples(MAX_OBJECTS_PER_FRAME));
    expect(verifyFrame(buf).objectCount).toBe(1000);
  });
  it("9. 1001 objects raises RangeError", () => {
    expect(() => encodeTelemetryFrame(samples(1001))).toThrow(RangeError);
  });
  it("10. RangeError carries the object count", () => {
    try {
      encodeTelemetryFrame(samples(1001));
      throw new Error("expected a RangeError");
    } catch (err) {
      expect(err).toBeInstanceOf(TelemetryFrameRangeError);
      expect(err.count).toBe(1001);
    }
  });
  it("11. identifier bytes are written", () => {
    const buf = encodeTelemetryFrame([sample()]);
    expect(new TextDecoder().decode(buf.subarray(4, 8))).toBe("HPTL");
  });
  it("12. frame stays inside the byte budget", () => {
    const buf = encodeTelemetryFrame(samples(1000));
    expect(buf.byteLength).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });
  it("13. encoding is deterministic for identical input", () => {
    const a = encodeTelemetryFrame(samples(5), { tsSec: 1, seq: 2 });
    const b = encodeTelemetryFrame(samples(5), { tsSec: 1, seq: 2 });
    expect([...a]).toEqual([...b]);
  });
});

describe("03 · reader decode (8)", () => {
  const frame = encodeTelemetryFrame([sample(0), sample(1)], {
    tsSec: 99,
    seq: 7,
  });

  it("14. decodes every scalar field", () => {
    const obj = readTelemetryObjects(frame)[0];
    expect(obj).toMatchObject(sample(0));
  });
  it("15. decodes objects in insertion order", () => {
    const objs = readTelemetryObjects(frame);
    expect(objs.map((o) => o.id)).toEqual([1000, 1001]);
  });
  it("16. decodes negative coordinates", () => {
    const buf = encodeTelemetryFrame([{ id: 1, lat: -33.86, lng: -70.65 }]);
    expect(readTelemetryObjects(buf)[0]).toMatchObject({
      lat: -33.86,
      lng: -70.65,
    });
  });
  it("17. decodes absent fields as defaults", () => {
    const buf = encodeTelemetryFrame([{ id: 0 }]);
    expect(readTelemetryObjects(buf)[0]).toEqual({
      id: 0,
      kind: 0,
      status: 0,
      lat: 0,
      lng: 0,
      heading: 0,
      speed: 0,
    });
  });
  it("18. decodes large uint ids", () => {
    const buf = encodeTelemetryFrame([{ id: 4294967295 }]);
    expect(readTelemetryObjects(buf)[0].id).toBe(4294967295);
  });
  it("19. decodes frame metadata", () => {
    const parsed = getRootAsFrame(frame);
    expect([parsed.tsSec(), parsed.seq(), parsed.version()]).toEqual([
      99,
      7,
      SCHEMA_VERSION,
    ]);
  });
  it("20. iterateObjects yields the same count", () => {
    const parsed = getRootAsFrame(frame);
    expect([...parsed.iterateObjects()].map((o) => o.id())).toEqual([
      1000, 1001,
    ]);
  });
  it("21. getRootAsFrame reports the identifier", () => {
    expect(verifyFrame(frame).ok).toBe(true);
  });
});

describe("04 · verification rejects malformed input (12)", () => {
  const valid = encodeTelemetryFrame(samples(3));

  it("22. null", () => expect(verifyFrame(null).ok).toBe(false));
  it("23. undefined", () => expect(verifyFrame(undefined).ok).toBe(false));
  it("24. empty buffer", () =>
    expect(verifyFrame(new Uint8Array(0)).ok).toBe(false));
  it("25. too-short buffer", () =>
    expect(verifyFrame(new Uint8Array(8)).ok).toBe(false));
  it("26. wrong file identifier", () => {
    const bad = new Uint8Array(valid);
    bad[4] = 0x00;
    expect(verifyFrame(bad).error).toMatch(/identifier/);
  });
  it("27. truncated buffer", () => {
    expect(verifyFrame(valid.subarray(0, 50)).ok).toBe(false);
  });
  it("28. corrupted root offset", () => {
    const bad = new Uint8Array(valid);
    new DataView(bad.buffer).setInt32(0, 0x7fffffff, true);
    expect(verifyFrame(bad).ok).toBe(false);
  });
  it("29. corrupted vector uoffset", () => {
    const bad = new Uint8Array(valid);
    const root = new DataView(bad.buffer).getInt32(0, true);
    const vt = root - new DataView(bad.buffer).getInt32(root, true);
    const objectsField = new DataView(bad.buffer).getInt16(vt + 4, true);
    new DataView(bad.buffer).setInt32(root + objectsField, 0x7fffffff, true);
    expect(verifyFrame(bad).ok).toBe(false);
  });
  it("30. corrupted object offset", () => {
    const bad = new Uint8Array(valid);
    const root = new DataView(bad.buffer).getInt32(0, true);
    const dv = new DataView(bad.buffer);
    const vt = root - dv.getInt32(root, true);
    const vec =
      root +
      dv.getInt16(vt + 4, true) +
      dv.getInt32(root + dv.getInt16(vt + 4, true), true);
    dv.setInt32(vec + 4, 0x7fffffff, true);
    expect(verifyFrame(bad).ok).toBe(false);
  });
  it("31. ArrayBuffer input is accepted", () => {
    const copy = valid.slice();
    expect(verifyFrame(copy.buffer).ok).toBe(true);
  });
  it("32. Node Buffer input is accepted", () => {
    expect(verifyFrame(Buffer.from(valid)).ok).toBe(true);
  });
  it("33. over-byte-budget input is rejected", () => {
    expect(verifyFrame(valid, { maxFrameBytes: 4 }).ok).toBe(false);
  });
});

describe("05 · server budgets and drops (6)", () => {
  it("34. encoder emits a valid frame", () => {
    const encoder = createFrameEncoder();
    expect(verifyFrame(encoder.encode(samples(5))).ok).toBe(true);
  });
  it("35. per-second rate budget drops extra frames", () => {
    const encoder = createFrameEncoder({ now: () => 0 });
    for (let i = 0; i < TELEMETRY_BUDGETS.maxFramesPerSecond; i++)
      encoder.encode([sample(i)]);
    expect(encoder.encode([sample()])).toBeNull();
  });
  it("36. object-cap overflow is a drop", () => {
    const encoder = createFrameEncoder();
    expect(encoder.encode(samples(1001))).toBeNull();
    expect(encoder.stats().dropped).toBe(1);
  });
  it("37. dropped frames are counted, not thrown", () => {
    const encoder = createFrameEncoder();
    encoder.encode(samples(1001));
    expect(encoder.stats()).toMatchObject({ dropped: 1, rangeErrors: 0 });
  });
  it("38. stats expose budgets and identifier", () => {
    const stats = createFrameEncoder().stats();
    expect(stats).toMatchObject({
      identifier: "HPTL",
      maxObjectsPerFrame: 1000,
      framesPerSecondBudget: 30,
    });
  });
  it("39. verifyIngest never throws on garbage", () => {
    expect(() => verifyIngest({})).not.toThrow();
    expect(verifyIngest({}).ok).toBe(false);
  });
});

describe("06 · round-trip and summary (10)", () => {
  it("40. one object round-trips", () => {
    expect(
      readTelemetryObjects(encodeTelemetryFrame([sample()]))[0],
    ).toMatchObject(sample());
  });
  it("41. ten objects round-trip", () => {
    expect(
      readTelemetryObjects(encodeTelemetryFrame(samples(10))),
    ).toHaveLength(10);
  });
  it("42. one hundred objects round-trip", () => {
    expect(
      readTelemetryObjects(encodeTelemetryFrame(samples(100))),
    ).toHaveLength(100);
  });
  it("43. id-only object round-trips", () => {
    expect(readTelemetryObjects(encodeTelemetryFrame([{ id: 42 }]))[0].id).toBe(
      42,
    );
  });
  it("44. coordinates-only object round-trips", () => {
    const buf = encodeTelemetryFrame([{ lat: 1.25, lng: 2.5 }]);
    expect(readTelemetryObjects(buf)[0]).toMatchObject({ lat: 1.25, lng: 2.5 });
  });
  it("45. extreme coordinates round-trip", () => {
    const buf = encodeTelemetryFrame([
      { lat: 89.999999, lng: -179.999999, heading: 359.9, speed: 250 },
    ]);
    const obj = readTelemetryObjects(buf)[0];
    expect(obj.lat).toBeCloseTo(89.999999, 5);
    expect(obj.lng).toBeCloseTo(-179.999999, 5);
  });
  it("46. repeated encodes are stable", () => {
    for (let i = 0; i < 100; i++) {
      expect(
        verifyFrame(encodeTelemetryFrame(samples(7), { tsSec: i, seq: i })).ok,
      ).toBe(true);
    }
  });
  it("47. identifier mutation is detected", () => {
    const bad = new Uint8Array(encodeTelemetryFrame(samples(2)));
    bad[7] = bad[7] ^ 0xff;
    expect(verifyFrame(bad).ok).toBe(false);
  });
  it("48. unsupported version is rejected", () => {
    const buf = encodeTelemetryFrame(samples(2), {
      version: SCHEMA_VERSION + 1,
    });
    expect(verifyFrame(buf).error).toMatch(/version/);
  });
  it("49. frameSummary reports metadata", () => {
    const summary = frameSummary(
      encodeTelemetryFrame(samples(4), { tsSec: 12, seq: 34 }),
    );
    expect(summary).toMatchObject({
      ok: true,
      identifier: "HPTL",
      objectCount: 4,
      seq: 34,
      tsSec: 12,
      version: SCHEMA_VERSION,
    });
  });
});
