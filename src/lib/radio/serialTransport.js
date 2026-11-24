/**
 * WebSerial transport for USB TNCs (Mobilinkd, FTDI/CH340 Baofeng cables).
 * Chromium-only, gesture-gated, foreground-only — the service worker can
 * never own the port (documented limitation relayed through swChannel).
 */

import { createKissDecoder, kissEncode } from "./kiss";

/** Common TNC VID/PID filters for the one-gesture connect flow. */
export const TNC_FILTERS = Object.freeze([
  { usbVendorId: 0x1d50, usbProductId: 0x60c6 }, // Mobilinkd TNC1/TNC2
  { usbVendorId: 0x0403, usbProductId: 0x6001 }, // FTDI USB-serial (Baofeng cables)
  { usbVendorId: 0x0403, usbProductId: 0x6015 }, // FTDI FT230X
  { usbVendorId: 0x1a86, usbProductId: 0x7523 }, // CH340 USB-serial
]);

export const BAUD_OPTIONS = Object.freeze([
  1200, 9600, 19200, 38400, 57600, 115200,
]);
export const DEFAULT_BAUD = 19200;
const PORT_PREF_KEY = "hp_radio_port";

export function isSerialSupported() {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export function loadPortPref() {
  try {
    return JSON.parse(localStorage.getItem(PORT_PREF_KEY) || "null");
  } catch {
    return null;
  }
}

export function savePortPref(pref) {
  try {
    localStorage.setItem(PORT_PREF_KEY, JSON.stringify(pref));
  } catch {
    // best-effort — surface failures are non-fatal here
  }
}

/**
 * Gesture-gated port picker. MUST be called from a user click handler.
 * @returns {Promise<SerialPort>}
 */
export async function requestRadioPort({ filters = TNC_FILTERS } = {}) {
  if (!isSerialSupported()) {
    throw new Error(
      "WebSerial is unavailable — use Chrome/Edge on Android or desktop",
    );
  }
  return navigator.serial.requestPort({ filters });
}

/**
 * Create a transport bound to one port. onKissPayload receives unescaped
 * KISS data payloads (command byte stripped).
 */
export function createSerialTransport({
  onKissPayload,
  onDisconnect,
  onError,
} = {}) {
  let port = null;
  let reader = null;
  let keepReading = false;
  let baudRate = DEFAULT_BAUD;

  async function open(targetPort, { baudRate: baud = DEFAULT_BAUD } = {}) {
    close();
    port = targetPort;
    baudRate = baud;
    await port.open({
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
    });
    const pref = safePortInfo(port);
    if (pref) savePortPref({ ...pref, baudRate });
    keepReading = true;
    readLoop().catch((err) => {
      if (onError) onError(err);
    });
    if (typeof port.addEventListener === "function") {
      port.addEventListener("disconnect", () => {
        if (onDisconnect) onDisconnect();
        close();
      });
    }
    return { baudRate, ...safePortInfo(port) };
  }

  async function readLoop() {
    const decoder = createKissDecoder();
    while (port && port.readable && keepReading) {
      reader = port.readable.getReader();
      try {
        while (keepReading) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && onKissPayload) {
            for (const frame of decoder.push(value)) onKissPayload(frame);
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // best-effort — surface failures are non-fatal here
        }
        reader = null;
      }
    }
  }

  async function write(bytes) {
    if (!port || !port.writable) throw new Error("radio port is not open");
    const framed = kissEncode(bytes);
    const writer = port.writable.getWriter();
    try {
      await writer.write(framed);
    } finally {
      writer.releaseLock();
    }
  }

  async function close() {
    keepReading = false;
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // best-effort — surface failures are non-fatal here
      }
      reader = null;
    }
    if (port) {
      try {
        await port.close();
      } catch {
        // best-effort — surface failures are non-fatal here
      }
      port = null;
    }
  }

  function isOpen() {
    return !!(port && port.readable);
  }

  function portInfo() {
    return safePortInfo(port);
  }

  return { open, write, close, isOpen, portInfo, baud: () => baudRate };
}

function safePortInfo(p) {
  try {
    const info = p && typeof p.getInfo === "function" ? p.getInfo() : {};
    return {
      usbVendorId: info.usbVendorId,
      usbProductId: info.usbProductId,
    };
  } catch {
    return null;
  }
}
