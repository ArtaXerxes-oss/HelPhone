import { describe, expect, it } from "vitest";
import {
  createKissDecoder,
  kissEncode,
  KISS_ESC,
  KISS_FEND,
  KISS_TFEND,
} from "../src/lib/radio/kiss";
import {
  HEADER_SIZE,
  MAX_FRAME,
  MSG,
  createReassembler,
  fragmentMessage,
  randomMsgId,
} from "../src/lib/radio/protocol";
import { sha256Hex, appendCrc16 } from "../src/lib/field/crypto";

describe("KISS framing", () => {
  it("round-trips a payload with embedded FEND/ESC bytes", () => {
    const payload = Uint8Array.from([0x01, KISS_FEND, 0x02, KISS_ESC, 0x03]);
    const framed = kissEncode(payload);
    const decoder = createKissDecoder();
    const frames = decoder.push(framed);
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0])).toEqual(Array.from(payload));
  });

  it("reassembles frames torn across arbitrary chunk boundaries", () => {
    const payload = Uint8Array.from([10, 20, 30, 40, 50]);
    const framed = kissEncode(payload);
    const decoder = createKissDecoder();
    const frames = [];
    for (let i = 0; i < framed.length; i++) {
      frames.push(...decoder.push(framed.subarray(i, i + 1)));
    }
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0])).toEqual(Array.from(payload));
  });

  it("ignores interleaved noise between frames (APRS beacons)", () => {
    const decoder = createKissDecoder();
    const noise = Uint8Array.from([0x3c, 0xff, 0x00]); // not inside a frame
    const framed = kissEncode(Uint8Array.from([1, 2, 3]));
    expect(decoder.push(noise)).toHaveLength(0);
    const frames = decoder.push(framed);
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0])).toEqual([1, 2, 3]);
  });
});

describe("fragmentation / reassembly", () => {
  it("splits a 2KB request into <=150B frames that reassemble byte-identical", async () => {
    const big = JSON.stringify({
      type: "medical",
      severity: 3,
      notes: "x".repeat(2200),
      address: "Via Roma 1, Milano",
    });
    expect(big.length).toBeGreaterThan(2000);
    const { frames, msgId } = fragmentMessage({
      type: MSG.REQUEST,
      payloadBytes: big,
    });
    for (const f of frames) expect(f.length).toBeLessThanOrEqual(MAX_FRAME);
    expect(frames.length).toBeGreaterThan(10);

    const reassembler = createReassembler();
    let complete = null;
    for (const f of frames) {
      const r = reassembler.push(f);
      if (r && r.payloadBytes) complete = r;
    }
    expect(complete).toBeTruthy();
    expect(complete.msgId).toBe(msgId);
    expect(new TextDecoder().decode(complete.payloadBytes)).toBe(big);
    expect(await sha256Hex(complete.payloadBytes)).toBe(
      await sha256Hex(new TextEncoder().encode(big)),
    );
  });

  it("survives 10% frame loss + duplicate retransmits", async () => {
    const payload = JSON.stringify({ id: "req-77", t: "MED", g: "JN59", s: 3 });
    const { frames, msgId } = fragmentMessage({
      type: MSG.SOS,
      payloadBytes: payload,
    });
    const reassembler = createReassembler();
    // First pass: drop every 10th frame, then re-send everything twice.
    frames.forEach((f, i) => {
      if (i % 10 !== 9) reassembler.push(f);
    });
    for (const f of frames) reassembler.push(f);
    for (const f of frames) reassembler.push(f);
    // Drain: push remaining until complete (dedupe must not corrupt).
    let complete = null;
    for (const f of frames) {
      const r = reassembler.push(f);
      if (r && r.payloadBytes) complete = r;
    }
    expect(complete).toBeTruthy();
    expect(complete.msgId).toBe(msgId);
    expect(new TextDecoder().decode(complete.payloadBytes)).toBe(payload);
  });

  it("rejects frames with corrupted CRC", () => {
    const { frames } = fragmentMessage({
      type: MSG.LOCATION,
      payloadBytes: "abc",
    });
    const corrupted = Uint8Array.from(frames[0]);
    corrupted[corrupted.length - 1] ^= 0xff;
    const result = createReassembler().push(corrupted);
    expect(result.error).toBe("crc");
  });

  it("rejects unknown protocol versions", () => {
    const { frames } = fragmentMessage({
      type: MSG.BEACON,
      payloadBytes: "abc",
    });
    const bumped = Uint8Array.from(frames[0]);
    bumped[0] = 99; // version byte
    // Recompute the frame CRC so the version check is what rejects it.
    const body = bumped.subarray(0, bumped.length - 2);
    const fixed = appendCrc16(Uint8Array.from(body));
    const result = createReassembler().push(fixed);
    expect(result.error).toBe("header");
  });

  it("header stays within the 10-byte budget", () => {
    const { frames } = fragmentMessage({
      type: MSG.REQUEST,
      payloadBytes: "x",
    });
    expect(frames[0].length).toBe(HEADER_SIZE + 1 + 2);
    expect(randomMsgId()).toBeGreaterThanOrEqual(0);
  });
});
