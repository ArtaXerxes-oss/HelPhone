/** ADR-014 follow-up 3: typed-array ingest and Mapbox custom-layer shape. */

import { describe, expect, it } from "vitest";
import { TelemetryBuffers } from "../src/lib/telemetryBuffers.ts";
import {
  createTelemetryLayer,
  TELEMETRY_SHADERS,
} from "../src/lib/telemetryLayer.ts";
import {
  encodeTelemetryFrame,
  verifyFrame,
} from "../src/lib/telemetryFrame.js";

const objects = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    kind: i % 3,
    status: i % 4,
    lat: 6.5244 + i / 10000,
    lng: 3.3792 - i / 10000,
    heading: (i * 5) % 360,
  }));

describe("TelemetryBuffers", () => {
  it("preallocates all six typed arrays", () => {
    const b = new TelemetryBuffers(100);
    expect(b.ids).toBeInstanceOf(Uint32Array);
    expect(b.kinds).toBeInstanceOf(Uint8Array);
    expect(b.statuses).toBeInstanceOf(Uint8Array);
    expect(b.lats).toBeInstanceOf(Float64Array);
    expect(b.lngs).toBeInstanceOf(Float64Array);
    expect(b.headings).toBeInstanceOf(Float32Array);
    expect(b.mercator.length).toBe(200);
  });

  it("ingests a frame without materialising objects", () => {
    const b = new TelemetryBuffers(100);
    const frame = encodeTelemetryFrame(objects(50), { seq: 3, tsSec: 100 });
    expect(b.ingest(frame)).toBe(50);
    expect(b.count).toBe(50);
    expect(b.seq).toBe(3);
    expect(b.tsSec).toBe(100);
    expect(b.ids[0]).toBe(1);
    expect(b.ids[49]).toBe(50);
    expect(b.lats[0]).toBeCloseTo(6.5244, 5);
    expect(b.statuses[1]).toBe(1);
  });

  it("computes WebGL mercator positions", () => {
    const b = new TelemetryBuffers(10);
    b.ingest(encodeTelemetryFrame([{ id: 1, lat: 0, lng: 0 }]));
    expect(b.mercator[0]).toBeCloseTo(0.5, 5);
    expect(b.mercator[1]).toBeCloseTo(0.5, 5);
  });

  it("accumulates across frames and resets without reallocating", () => {
    const b = new TelemetryBuffers(200);
    const idsBefore = b.ids.buffer;
    for (let i = 0; i < 4; i++) b.ingest(encodeTelemetryFrame(objects(25)));
    expect(b.count).toBe(100);
    b.reset();
    expect(b.count).toBe(0);
    expect(b.ids.buffer).toBe(idsBefore);
  });

  it("drops malformed frames without throwing", () => {
    const b = new TelemetryBuffers(10);
    expect(b.ingest(new Uint8Array([1, 2, 3]))).toBe(0);
    expect(b.dropped).toBe(1);
    expect(b.count).toBe(0);
  });

  it("respects capacity and counts overflow as dropped", () => {
    const b = new TelemetryBuffers(30);
    expect(b.ingest(encodeTelemetryFrame(objects(50)))).toBe(30);
    expect(b.dropped).toBe(20);
  });

  it("exposes a plain object only through get() (JSON popup path)", () => {
    const b = new TelemetryBuffers(10);
    b.ingest(encodeTelemetryFrame(objects(2)));
    expect(b.get(0)).toEqual({
      id: 1,
      kind: 0,
      status: 0,
      lat: expect.any(Number),
      lng: expect.any(Number),
      heading: expect.any(Number),
    });
    expect(b.get(99)).toBeNull();
  });

  it("increments generation on ingest so the GL layer re-uploads", () => {
    const b = new TelemetryBuffers(10);
    const before = b.generation;
    b.ingest(encodeTelemetryFrame(objects(1)));
    expect(b.generation).toBe(before + 1);
  });
});

describe("Mapbox custom layer", () => {
  it("declares a 2D custom layer", () => {
    const layer = createTelemetryLayer(new TelemetryBuffers(10));
    expect(layer).toMatchObject({
      id: "helphone-telemetry",
      type: "custom",
      renderingMode: "2d",
    });
    expect(typeof layer.onAdd).toBe("function");
    expect(typeof layer.render).toBe("function");
    expect(typeof layer.onRemove).toBe("function");
  });

  it("ships shaders that read status directly from the attribute buffer", () => {
    expect(TELEMETRY_SHADERS.vertex).toContain("a_pos");
    expect(TELEMETRY_SHADERS.fragment).toContain("gl_PointCoord");
  });

  it("renders without throwing when no GL program is attached", () => {
    const layer = createTelemetryLayer(new TelemetryBuffers(10));
    expect(() => layer.render({}, [])).not.toThrow();
  });
});
