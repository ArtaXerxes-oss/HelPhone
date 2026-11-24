/**
 * KISS framing (http://kiss.tinyshell.net) for TNC byte streams.
 * FEND-delimited, escape-encoded. A streaming decoder absorbs the torn
 * chunks a USB-serial WebSerial reader actually delivers.
 */

export const KISS_FEND = 0xc0;
export const KISS_ESC = 0xdb;
export const KISS_TFEND = 0xdc;
export const KISS_TFESC = 0xdd;
export const KISS_CMD_DATA = 0x00;

/** Wrap payload bytes in a KISS frame with escaping. */
export function kissEncode(payload) {
  const out = [KISS_FEND, KISS_CMD_DATA];
  for (let i = 0; i < payload.length; i++) {
    const b = payload[i];
    if (b === KISS_FEND) out.push(KISS_ESC, KISS_TFEND);
    else if (b === KISS_ESC) out.push(KISS_ESC, KISS_TFESC);
    else out.push(b);
  }
  out.push(KISS_FEND);
  return Uint8Array.from(out);
}

/**
 * Streaming KISS decoder. push() accepts arbitrary chunk boundaries (torn
 * frames) and returns zero or more complete unescaped payloads.
 */
export function createKissDecoder() {
  let buffer = [];
  let escaping = false;
  let inFrame = false;

  function push(chunk) {
    const frames = [];
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (b === KISS_FEND) {
        if (inFrame && buffer.length > 1) {
          // buffer[0] is the KISS command byte; keep only data after it.
          frames.push(Uint8Array.from(buffer.slice(1)));
        }
        buffer = [];
        escaping = false;
        inFrame = true;
        continue;
      }
      if (!inFrame) continue;
      if (escaping) {
        if (b === KISS_TFEND) buffer.push(KISS_FEND);
        else if (b === KISS_TFESC) buffer.push(KISS_ESC);
        else buffer.push(b);
        escaping = false;
      } else if (b === KISS_ESC) {
        escaping = true;
      } else {
        buffer.push(b);
      }
    }
    return frames;
  }

  function reset() {
    buffer = [];
    escaping = false;
    inFrame = false;
  }

  return { push, reset };
}
