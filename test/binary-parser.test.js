// @vitest-environment node
// Binary telemetry codecs (spike, ADR-014): round trips, zero-copy readers,
// Cap'n Proto far pointers, malformed input, and the WASM reader. Wire
// compatibility with flatc / capnp / protoc is checked separately by
// scripts/spikes/binary_conformance.js, which needs those compilers.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CAPNP_MAP_OBJECT_LAYOUT,
  FLATBUFFERS_VTABLE_SLOTS,
  FORMATS,
  FlatMapObject,
  FlatTelemetryFrame,
  createPositionBuffer,
  decodeCapnp,
  decodeFrame,
  decodeProtobuf,
  encodeCapnp,
  encodeFlatBuffers,
  encodeFrame,
  encodeProtobuf,
  generateMapObjects,
  openCapnpFrame,
  openFlatBuffersFrame,
  readPositions,
} from "../src/utils/binaryParser.js";
import { createWasmPositionReader } from "../src/utils/binaryParserWasm.js";

const WASM = new URL("../src/wasm/telemetry_reader.wasm", import.meta.url);
const POSITION_FIELDS = ["id", "kind", "status", "latE6", "lngE6", "headingCdeg"];

const plain = (frame) => JSON.parse(JSON.stringify(frame, (k, v) => (v instanceof Int32Array ? Array.from(v) : v)));

function edgeObject(overrides = {}) {
  return {
    id: 0xffffffff, kind: 1, status: 3, priority: 3, latE6: -89_999_999, lngE6: -179_999_999,
    headingCdeg: 35999, speedCms: 65535, etaSeconds: 0xffffffff, requestId: 0x7fffffff, tsMs: 2 ** 53 - 1,
    emergencyType: "Ọ̀ṣun flood 🌊", responder: "G".padEnd(56, "A"), trail: Int32Array.from([-(2 ** 31), 2 ** 31 - 1, 0, -1]),
    ...overrides,
  };
}

const FRAMES = {
  empty: { seq: 0, sentAtMs: 0, objects: [] },
  edge: {
    seq: 0xffffffff,
    sentAtMs: 1_790_000_000_000.5,
    objects: [
      edgeObject(),
      edgeObject({ id: 0, kind: 0, status: 0, priority: 0, latE6: 0, lngE6: 0, headingCdeg: 0, speedCms: 0, etaSeconds: 0, requestId: 0, tsMs: 0, emergencyType: "", responder: "", trail: new Int32Array(0) }),
    ],
  },
  generated: { seq: 42, sentAtMs: 1_790_000_000_123, objects: generateMapObjects(300, { seed: 9 }) },
};

describe("round trips", () => {
  for (const format of FORMATS) {
    for (const [name, frame] of Object.entries(FRAMES)) {
      it(`${format}: ${name} frame decodes to the same objects`, () => {
        expect(plain(decodeFrame(format, encodeFrame(format, frame)))).toEqual(plain(frame));
      });
    }
  }

  it("binary formats are smaller than JSON, protobuf smallest", () => {
    const size = (f) => encodeFrame(f, FRAMES.generated).length;
    expect(size("protobuf")).toBeLessThan(size("capnp"));
    expect(size("capnp")).toBeLessThan(size("json"));
    expect(size("flatbuffers")).toBeLessThan(size("json"));
  });
});

describe("readPositions (render path)", () => {
  for (const format of FORMATS) {
    it(`${format}: fills the position buffer and grows it when needed`, () => {
      const frame = FRAMES.generated;
      const out = createPositionBuffer(8);
      expect(readPositions(format, encodeFrame(format, frame), out)).toBe(frame.objects.length);
      expect(out.capacity).toBeGreaterThanOrEqual(frame.objects.length);
      frame.objects.forEach((o, i) => {
        for (const k of POSITION_FIELDS) expect(out[k][i]).toBe(o[k]);
      });
    });
  }

  it("reuses the same arrays when capacity suffices", () => {
    const out = createPositionBuffer(1024);
    const lat = out.latE6;
    readPositions("flatbuffers", encodeFrame("flatbuffers", FRAMES.generated), out);
    readPositions("capnp", encodeFrame("capnp", FRAMES.generated), out);
    expect(out.latE6).toBe(lat);
  });

  it("rejects unknown formats", () => {
    expect(() => readPositions("xml", new Uint8Array(8), createPositionBuffer())).toThrow(/unknown telemetry format/);
  });
});

describe("FlatBuffers zero-copy access", () => {
  const bytes = encodeFlatBuffers(FRAMES.generated);

  it("carries the HPTL file identifier", () => {
    expect(FlatTelemetryFrame.hasIdentifier(bytes)).toBe(true);
    expect(FlatTelemetryFrame.hasIdentifier(encodeCapnp(FRAMES.generated))).toBe(false);
  });

  it("reads fields through a reused flyweight", () => {
    const f = openFlatBuffersFrame(bytes);
    const m = new FlatMapObject();
    expect(f.objectsLength()).toBe(300);
    expect(f.seq()).toBe(42);
    for (const i of [0, 150, 299]) {
      expect(f.object(i, m)).toBe(m);
      const o = FRAMES.generated.objects[i];
      expect(m.latE6()).toBe(o.latE6);
      expect(m.responder()).toBe(o.responder);
      expect(m.trailLength()).toBe(o.trail.length);
    }
  });

  it("returns defaults for fields a table omits", () => {
    const m = openFlatBuffersFrame(encodeFlatBuffers(FRAMES.edge)).object(1);
    expect(m.responder()).toBe("");
    expect(m.emergencyType()).toBe("");
    expect(m.trailLength()).toBe(0);
    expect(m.trailArray()).toHaveLength(0);
  });

  it("trailArray is a view into the frame when aligned, a copy when not", () => {
    const f = openFlatBuffersFrame(bytes);
    const view = f.object(299).trailArray();
    expect(view.buffer).toBe(bytes.buffer);

    // Same frame at an odd byte offset inside a larger buffer.
    const shifted = new Uint8Array(bytes.length + 1);
    shifted.set(bytes, 1);
    const copy = openFlatBuffersFrame(shifted.subarray(1)).object(299).trailArray();
    expect(copy.buffer).not.toBe(shifted.buffer);
    expect(Array.from(copy)).toEqual(Array.from(view));
  });

  it("vtable slots match the field ids in telemetry.fbs", () => {
    const schema = readFileSync(new URL("../src/schemas/telemetry.fbs", import.meta.url), "utf8");
    const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    const ids = Object.fromEntries([...schema.matchAll(/^\s+(\w+):[^;]*\(id: (\d+)\)/gm)].map((m) => [camel(m[1]), Number(m[2])]));
    expect(Object.keys(ids)).toHaveLength(14);
    for (const [field, id] of Object.entries(ids)) expect(FLATBUFFERS_VTABLE_SLOTS[field]).toBe(4 + 2 * id);
  });
});

describe("Cap'n Proto", () => {
  it("layout matches the bits[...] offsets recorded in telemetry.capnp", () => {
    const schema = readFileSync(new URL("../src/schemas/telemetry.capnp", import.meta.url), "utf8");
    const mapObject = schema.slice(schema.indexOf("struct MapObject"), schema.indexOf("struct TelemetryFrame"));
    const bits = [...mapObject.matchAll(/^\s+(\w+) @\d+ :\w+;\s+# bits\[(\d+), \d+\)/gm)];
    expect(bits).toHaveLength(11);
    for (const [, field, start] of bits) expect(CAPNP_MAP_OBJECT_LAYOUT.byteOffsets[field]).toBe(Number(start) / 8);
    expect(mapObject).toMatch(/Data section: 5 words.*Pointer section: 3 words/s);
  });

  it("reads through the flyweight without materialising", () => {
    const f = openCapnpFrame(encodeCapnp(FRAMES.edge));
    const m = f.object(0);
    expect(m.id()).toBe(0xffffffff);
    expect(m.lngE6()).toBe(-179_999_999);
    expect(m.emergencyType()).toBe("Ọ̀ṣun flood 🌊");
    expect(Array.from(m.trailArray())).toEqual([-(2 ** 31), 2 ** 31 - 1, 0, -1]);
    expect(f.object(1).responder()).toBe("");
  });

  // Rebuilds our single-segment message as the official builders do once a
  // message outgrows its first segment: the object list lives in another
  // segment, reached through a far (or double-far) pointer.
  function splitIntoSegments(frame, doubleFar) {
    const single = encodeCapnp(frame);
    const v = new DataView(single.buffer);
    const frameAt = 16; // header (8) + root pointer (8)
    const listPtrAt = frameAt + 16;
    const lo = v.getUint32(listPtrAt, true);
    const hi = v.getUint32(listPtrAt + 4, true);
    const tagAt = listPtrAt + 8 + (lo >> 2) * 8;

    const seg0 = single.slice(8, tagAt); // root pointer + frame struct
    const body = single.slice(tagAt); // tag, elements, text/list bodies
    const pad = new Uint8Array(doubleFar ? 16 : 8);
    const pv = new DataView(pad.buffer);
    let seg1, seg2;
    if (!doubleFar) {
      // seg1 = [landing pad: list pointer to the next word] + body
      pv.setUint32(0, 1, true); // offset 0, list
      pv.setUint32(4, hi, true);
      seg1 = new Uint8Array(pad.length + body.length);
      seg1.set(pad);
      seg1.set(body, pad.length);
    } else {
      // seg1 = body; seg2 = [far pointer to seg1 word 0][tag: list, offset 0]
      seg1 = body;
      pv.setUint32(0, 2, true); // single far, pad offset 0
      pv.setUint32(4, 1, true); // segment 1
      pv.setUint32(8, 1, true); // tag: list pointer
      pv.setUint32(12, hi, true);
      seg2 = pad;
    }
    const s0 = new DataView(seg0.buffer, seg0.byteOffset);
    s0.setUint32(listPtrAt - 8, doubleFar ? 2 | 4 : 2, true); // far pointer, landing pad at word 0
    s0.setUint32(listPtrAt - 8 + 4, doubleFar ? 2 : 1, true); // in segment 2 / 1
    const segments = doubleFar ? [seg0, seg1, seg2] : [seg0, seg1];
    const header = (4 + 4 * segments.length + 7) & ~7;
    const out = new Uint8Array(header + segments.reduce((n, s) => n + s.length, 0));
    const ov = new DataView(out.buffer);
    ov.setUint32(0, segments.length - 1, true);
    let at = header;
    segments.forEach((s, i) => {
      ov.setUint32(4 + 4 * i, s.length / 8, true);
      out.set(s, at);
      at += s.length;
    });
    return out;
  }

  for (const doubleFar of [false, true]) {
    it(`follows ${doubleFar ? "double-far" : "far"} pointers across segments`, () => {
      const bytes = splitIntoSegments(FRAMES.generated, doubleFar);
      expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(doubleFar ? 2 : 1);
      expect(plain(decodeCapnp(bytes))).toEqual(plain(FRAMES.generated));
      const out = createPositionBuffer(1);
      readPositions("capnp", bytes, out);
      expect(out.lngE6[299]).toBe(FRAMES.generated.objects[299].lngE6);
    });
  }

  it("rejects messages whose segment table exceeds the buffer", () => {
    const bytes = encodeCapnp(FRAMES.generated);
    new DataView(bytes.buffer).setUint32(4, 1e6, true);
    expect(() => openCapnpFrame(bytes)).toThrow(/segments exceed buffer/);
  });
});

describe("Protocol Buffers", () => {
  it("skips unknown fields and accepts unpacked repeated trail values", () => {
    // MapObject { id: 7, <field 99 varint 5>, trail: -3 (unpacked), trail: 4 (unpacked) }
    const obj = [0x08, 7, 0x98, 0x06, 5, 0x70, 5, 0x70, 8];
    const bytes = Uint8Array.from([0x1a, obj.length, ...obj]);
    const o = decodeProtobuf(bytes).objects[0];
    expect(o.id).toBe(7);
    expect(Array.from(o.trail)).toEqual([-3, 4]);
  });

  it("accepts 10-byte varints for 32-bit fields", () => {
    // heading_cdeg written as a sign-extended int32 by a lenient encoder
    const obj = [0x38, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
    const o = decodeProtobuf(Uint8Array.from([0x1a, obj.length, ...obj])).objects[0];
    expect(o.headingCdeg).toBe(0xffffffff);
  });

  it("detects truncation inside a field (but not at a field boundary)", () => {
    const bytes = encodeProtobuf(FRAMES.generated);
    let caught = 0;
    for (let cut = 1; cut < 400; cut += 3) {
      try {
        decodeProtobuf(bytes.subarray(0, cut));
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        caught++;
      }
    }
    expect(caught).toBeGreaterThan(100);
  });
});

describe("malformed zero-copy buffers fail loudly", () => {
  for (const format of ["flatbuffers", "capnp"]) {
    it(`${format}: truncated frames throw instead of reading garbage`, () => {
      const bytes = encodeFrame(format, FRAMES.generated);
      for (const cut of [4, 64, bytes.length >> 1]) {
        expect(() => readPositions(format, bytes.subarray(0, cut), createPositionBuffer(512))).toThrow();
      }
    });
  }
});

describe("WASM reader", () => {
  it("matches the checked-in SHA-256 sidecar", () => {
    const wasm = readFileSync(WASM);
    const expected = readFileSync(new URL("../src/wasm/telemetry_reader.wasm.sha256", import.meta.url), "utf8").trim();
    expect(createHash("sha256").update(wasm).digest("hex")).toBe(expected);
  });

  it("produces the same positions as the JS readers and grows on demand", async () => {
    const reader = await createWasmPositionReader(readFileSync(WASM), { initialCapacity: 4, initialInputBytes: 64 });
    for (const format of ["flatbuffers", "capnp"]) {
      for (const frame of Object.values(FRAMES)) {
        expect(reader.readPositions(format, encodeFrame(format, frame))).toBe(frame.objects.length);
        frame.objects.forEach((o, i) => {
          for (const k of POSITION_FIELDS) expect(reader.positions[k][i]).toBe(o[k]);
        });
      }
    }
  });

  it("rejects corrupt offsets instead of reading out of bounds", async () => {
    const reader = await createWasmPositionReader(readFileSync(WASM));
    const bytes = encodeFlatBuffers(FRAMES.generated);
    new DataView(bytes.buffer).setUint32(0, 0x7fffffff, true);
    expect(() => reader.readPositions("flatbuffers", bytes)).toThrow(/rejected the frame/);
    expect(() => reader.readPositions("json", bytes)).toThrow(/supports/);
  });
});
