/**
 * swChannel — relay bus between the service worker, backgrounded clients and
 * the foreground page. The service worker can never hold a WebSerial port or
 * an NDEFReader (ISP-135/ISP-134 documented limitation): all radio/NFC I/O
 * lives in the foreground and is relayed here. TX intents created while
 * backgrounded are parked in a localStorage queue for foreground flush.
 */

const CHANNEL_NAME = "helphone-sw";
const BG_TX_KEY = "hp_bg_tx_queue";

let channel = null;

function bc() {
  if (channel) return channel;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(CHANNEL_NAME);
      return channel;
    }
  } catch {
    // best-effort — surface failures are non-fatal here
  }
  return null;
}

/** Post a relay message to sibling tabs and the controlling service worker. */
export function postSwMessage(type, payload = {}) {
  const msg = { type, payload, ts: Date.now() };
  const c = bc();
  if (c) {
    try {
      c.postMessage(msg);
    } catch {
      // best-effort — surface failures are non-fatal here
    }
  }
  try {
    const reg = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (reg) reg.postMessage(msg);
  } catch {
    // best-effort — surface failures are non-fatal here
  }
  return msg;
}

/** Subscribe to relay messages. Returns an unsubscribe function. */
export function subscribeSwMessages(handler) {
  const c = bc();
  if (!c) return () => {};
  const listener = (event) => handler(event.data);
  c.addEventListener("message", listener);
  let swListener = null;
  try {
    if (navigator.serviceWorker) {
      swListener = (event) => handler(event.data);
      navigator.serviceWorker.addEventListener("message", swListener);
    }
  } catch {
    // best-effort — surface failures are non-fatal here
  }
  return () => {
    try {
      c.removeEventListener("message", listener);
      if (swListener)
        navigator.serviceWorker.removeEventListener("message", swListener);
    } catch {
      // best-effort — surface failures are non-fatal here
    }
  };
}

function readBgQueue() {
  try {
    const v = JSON.parse(localStorage.getItem(BG_TX_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeBgQueue(items) {
  try {
    localStorage.setItem(BG_TX_KEY, JSON.stringify(items.slice(-200)));
  } catch {
    // best-effort — surface failures are non-fatal here
  }
}

/**
 * Park a TX intent created while the page was backgrounded. Foreground
 * (radio bridge / online sync) drains it on resume — background TX over
 * WebSerial is impossible by design.
 */
export function queueBackgroundTx(item) {
  const queue = readBgQueue();
  const entry = { ...item, queuedAt: item.queuedAt || Date.now() };
  queue.push(entry);
  writeBgQueue(queue);
  return entry;
}

export function backgroundTxDepth() {
  return readBgQueue().length;
}

/** Drain parked background TX intents (foreground flush). */
export function takeBackgroundTx() {
  const queue = readBgQueue();
  writeBgQueue([]);
  return queue;
}
