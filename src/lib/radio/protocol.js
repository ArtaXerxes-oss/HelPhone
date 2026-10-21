/**
 * Compact wire protocol for the 150-byte VHF packet MTU (ISP-135).
 *
 * Frame layout (header 10B + payload, CRC-16 trailing):
 *   ver(1) type(1) prio(1) msgId(4) fragIdx(1) fragCount(1) payload... crc16(2)
 *
 * Fragments carry no callsigns in the header — band plan owns addressing:
 * ham mode embeds a 2-letter triage code + grid square in the payload and
 * keeps callsigns in the payload header block; licensed mode encrypts the
 * whole payload with compact AEAD (see bandPlan.js). Dedupe is by
 * (msgId, fragIdx) so duplicate retransmits and interleaved APRS beacons
 * cannot corrupt reassembly.
 */

import {
  appendCrc16,
  crc16,
  randomBytes,
  verifyCrc16,
  utf8Encode,
  utf8Decode,
} from "../field/crypto";

export const PROTO_VERSION = 1;
export const MAX_FRAME = 150;
export const HEADER_SIZE = 10;

export const MSG = Object.freeze({
  SOS: 0,
  REQUEST: 1,
  LOCATION: 2,
  ROSTER: 3,
  ACK: 4,
  BEACON: 5,
});

/** Default priority lane per message type (0 = SOS lane drains first). */
export const PRIO_BY_TYPE = Object.freeze({
  [MSG.SOS]: 0,
  [MSG.REQUEST]: 1,
  [MSG.ROSTER]: 2,
  [MSG.ACK]: 2,
  [MSG.LOCATION]: 3,
  [MSG.BEACON]: 3,
});

export function randomMsgId() {
  const b = randomBytes(4);
  return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}

export function encodeHeader({
  ver = PROTO_VERSION,
  type,
  prio,
  msgId,
  fragIdx,
  fragCount,
  bodyCrc,
}) {
  return Uint8Array.from([
    ver & 0xff,
    type & 0xff,
    prio & 0xff,
    (msgId >>> 24) & 0xff,
    (msgId >>> 16) & 0xff,
    (msgId >>> 8) & 0xff,
    msgId & 0xff,
    fragIdx & 0xff,
    fragCount & 0xff,
    (bodyCrc >> 8) & 0xff,
  ]);
}

export function decodeHeader(bytes) {
  if (!bytes || bytes.length < HEADER_SIZE) return null;
  const ver = bytes[0];
  if (ver !== PROTO_VERSION) return null;
  const msgId =
    ((bytes[3] << 24) | (bytes[4] << 16) | (bytes[5] << 8) | bytes[6]) >>> 0;
  return {
    ver,
    type: bytes[1],
    prio: bytes[2],
    msgId,
    fragIdx: bytes[7],
    fragCount: bytes[8],
    bodyCrcHigh: bytes[9],
  };
}

/**
 * Fragment a payload into <= maxFrame frames (each includes the 10B header
 * and 2B CRC). Header stores the high byte of the full-body CRC-16; each
 * frame also carries its own CRC over header+payload.
 */
export function fragmentMessage({
  type,
  payloadBytes,
  prio = PRIO_BY_TYPE[type] ?? 1,
  msgId = randomMsgId(),
  maxFrame = MAX_FRAME,
}) {
  const body =
    typeof payloadBytes === "string" ? utf8Encode(payloadBytes) : payloadBytes;
  const bodyCrc = crc16(body);
  const perFramePayload = maxFrame - HEADER_SIZE - 2;
  if (perFramePayload <= 0) throw new Error("maxFrame too small for header");
  const fragCount = Math.max(1, Math.ceil(body.length / perFramePayload));
  if (fragCount > 255)
    throw new Error("payload too large: fragment count > 255");
  const frames = [];
  for (let idx = 0; idx < fragCount; idx++) {
    const slice = body.subarray(
      idx * perFramePayload,
      (idx + 1) * perFramePayload,
    );
    const header = encodeHeader({
      type,
      prio,
      msgId,
      fragIdx: idx,
      fragCount,
      bodyCrc,
    });
    const headAndBody = new Uint8Array(header.length + slice.length);
    headAndBody.set(header, 0);
    headAndBody.set(slice, header.length);
    frames.push(appendCrc16(headAndBody));
  }
  return { msgId, type, prio, bodyCrc, frames };
}

/**
 * Reassembler with (msgId, fragIdx) dedupe + TTL. push() accepts one frame
 * (header+payload+CRC) and returns the completed message exactly once.
 */
export function createReassembler({
  ttlMs = 120000,
  now = () => Date.now(),
} = {}) {
  const pendingMsgs = new Map(); // msgId -> bucket

  function purge() {
    const t = now();
    for (const [msgId, bucket] of pendingMsgs) {
      if (t - bucket.startedAt > ttlMs) pendingMsgs.delete(msgId);
    }
  }

  function push(frame) {
    purge();
    const body = verifyCrc16(frame);
    if (!body) return { error: "crc" };
    const header = decodeHeader(body);
    if (!header) return { error: "header" };
    const payload = body.subarray(HEADER_SIZE);

    let bucket = pendingMsgs.get(header.msgId);
    if (!bucket) {
      bucket = {
        type: header.type,
        prio: header.prio,
        fragCount: header.fragCount,
        frags: new Map(),
        startedAt: now(),
        bodyCrcHigh: header.bodyCrcHigh,
      };
      pendingMsgs.set(header.msgId, bucket);
    }
    if (bucket.fragCount !== header.fragCount || bucket.type !== header.type) {
      pendingMsgs.delete(header.msgId);
      return { error: "mismatch" };
    }
    if (bucket.frags.has(header.fragIdx)) {
      return { duplicate: true, msgId: header.msgId, fragIdx: header.fragIdx };
    }
    bucket.frags.set(header.fragIdx, payload);

    if (bucket.frags.size < bucket.fragCount)
      return { partial: true, msgId: header.msgId };

    const total = [...bucket.frags.values()].reduce((n, f) => n + f.length, 0);
    const assembled = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < bucket.fragCount; i++) {
      const part = bucket.frags.get(i);
      if (!part) return { error: "missing-frag" };
      assembled.set(part, off);
      off += part.length;
    }
    pendingMsgs.delete(header.msgId);
    return {
      msgId: header.msgId,
      type: header.type,
      prio: header.prio,
      bodyCrcHigh: bucket.bodyCrcHigh,
      payloadBytes: assembled,
    };
  }

  function pending() {
    purge();
    return pendingMsgs.size;
  }

  return { push, pending };
}

export function payloadToString(payloadBytes) {
  return utf8Decode(payloadBytes);
}
