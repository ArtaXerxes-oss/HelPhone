/**
 * Shared crypto/encoding helpers for field transports (radio, NFC, offline
 * queue). Zero-dependency; uses WebCrypto where available (Node >= 18 and all
 * modern browsers expose globalThis.crypto.subtle).
 */

const HEX = "0123456789abcdef";

export function utf8Encode(str) {
  return new TextEncoder().encode(str);
}

export function utf8Decode(bytes) {
  return new TextDecoder().decode(bytes);
}

export function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
  }
  return out;
}

export function hexToBytes(hex) {
  const clean = String(hex || "").trim();
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

export function concatBytes(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function randomBytes(length) {
  const out = new Uint8Array(length);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export function randomHex(byteLength) {
  return bytesToHex(randomBytes(byteLength));
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — used on every radio frame. */
export function crc16(bytes) {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function appendCrc16(bytes) {
  const crc = crc16(bytes);
  const out = new Uint8Array(bytes.length + 2);
  out.set(bytes, 0);
  out[bytes.length] = (crc >> 8) & 0xff;
  out[bytes.length + 1] = crc & 0xff;
  return out;
}

/** Returns payload bytes without the trailing CRC, or null when CRC mismatches. */
export function verifyCrc16(bytesWithCrc) {
  if (!bytesWithCrc || bytesWithCrc.length < 3) return null;
  const body = bytesWithCrc.subarray(0, bytesWithCrc.length - 2);
  const expected =
    (bytesWithCrc[bytesWithCrc.length - 2] << 8) |
    bytesWithCrc[bytesWithCrc.length - 1];
  return crc16(body) === expected ? body : null;
}

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error(
      "WebCrypto (crypto.subtle) is unavailable in this environment",
    );
  }
  return c.subtle;
}

export async function sha256Hex(input) {
  const bytes = typeof input === "string" ? utf8Encode(input) : input;
  const digest = await subtle().digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(keyInput, dataInput) {
  const keyBytes =
    typeof keyInput === "string" ? utf8Encode(keyInput) : keyInput;
  const dataBytes =
    typeof dataInput === "string" ? utf8Encode(dataInput) : dataInput;
  const key = await subtle().importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await subtle().sign("HMAC", key, dataBytes);
  return bytesToHex(new Uint8Array(sig));
}

/** AES-256-GCM compact AEAD: out = iv(12B) || ciphertext+tag. */
export async function aesGcmEncrypt(keyInput, plaintextInput) {
  const keyBytes =
    typeof keyInput === "string" ? hexToBytes(keyInput) : keyInput;
  const plain =
    typeof plaintextInput === "string"
      ? utf8Encode(plaintextInput)
      : plaintextInput;
  const iv = randomBytes(12);
  const key = await subtle().importKey(
    "raw",
    ensure32(keyBytes),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ct = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv }, key, plain),
  );
  return concatBytes(iv, ct);
}

export async function aesGcmDecrypt(keyInput, blobInput) {
  const keyBytes =
    typeof keyInput === "string" ? hexToBytes(keyInput) : keyInput;
  const blob =
    typeof blobInput === "string" ? hexToBytes(blobInput) : blobInput;
  if (!blob || blob.length < 13) throw new Error("AEAD blob too short");
  const iv = blob.subarray(0, 12);
  const ct = blob.subarray(12);
  const key = await subtle().importKey(
    "raw",
    ensure32(keyBytes),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plain = await subtle().decrypt({ name: "AES-GCM", iv }, key, ct);
  return new Uint8Array(plain);
}

function ensure32(bytes) {
  if (bytes.length === 32) return bytes;
  const out = new Uint8Array(32);
  out.set(bytes.subarray(0, Math.min(32, bytes.length)), 0);
  return out;
}

/** Stable short id (uint32) derived from arbitrary input — used for msgId. */
export function uint32Id(input) {
  const hex =
    typeof input === "string" &&
    input.length <= 16 &&
    /^[0-9a-f]+$/i.test(input)
      ? input
      : null;
  if (hex) return parseInt(hex.padStart(8, "0").slice(-8), 16) >>> 0;
  let h = 0x811c9dc5;
  const str = typeof input === "string" ? input : bytesToHex(input);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
