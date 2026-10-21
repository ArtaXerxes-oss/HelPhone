/**
 * Radio bridge orchestrator (ISP-135): WebSerial transport + KISS framing +
 * fragment/reassemble + half-duplex priority scheduler + band-plan encoding.
 * UI subscribes for state; RX intents are relayed over swChannel so
 * backgrounded clients stay in the loop (TX from background is queued only).
 */

import { duck, playTone } from "../field/audioAlert";
import { sha256Hex } from "../field/crypto";
import { PRIO } from "../field/offlineQueue";
import {
  backgroundTxDepth,
  postSwMessage,
  queueBackgroundTx,
  takeBackgroundTx,
} from "../field/swChannel";
import { BAND_MODES, toWire, fromWire } from "./bandPlan";
import {
  MSG,
  PRIO_BY_TYPE,
  createReassembler,
  fragmentMessage,
  randomMsgId,
} from "./protocol";
import { createScheduler } from "./scheduler";
import {
  BAUD_OPTIONS,
  DEFAULT_BAUD,
  createSerialTransport,
  isSerialSupported,
  loadPortPref,
  requestRadioPort,
} from "./serialTransport";

export const RADIO_STATUS = Object.freeze({
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  LINKED: "linked",
});

export function createRadioBridge({
  callsign = "HEL-04",
  baseCallsign = "HEL-BASE",
  band = BAND_MODES.HAM,
  sessionKeyHex = null,
  onEvent = () => {},
} = {}) {
  const config = { callsign, baseCallsign, band, baudRate: DEFAULT_BAUD };
  const listeners = [onEvent];
  const state = {
    status: RADIO_STATUS.DISCONNECTED,
    band,
    callsign,
    baudRate: DEFAULT_BAUD,
    txQueued: 0,
    txActive: false,
    rxCount: 0,
    txCount: 0,
    lastRxAt: null,
    lastTxAt: null,
    lastError: null,
    backgroundTxParked: backgroundTxDepth(),
  };

  const seenMsgIds = new Set();
  const reassembler = createReassembler();
  let transport = null;
  let scheduler = null;

  function emit(type, extra = {}) {
    const event = { type, state: { ...state }, ...extra };
    for (const fn of listeners) {
      try {
        fn(event);
      } catch {
        // best-effort — surface failures are non-fatal here
      }
    }
  }

  function setState(patch) {
    Object.assign(state, patch);
    emit("state");
  }

  function carrierSense() {
    // No CTS line on typical AFSK TNCs — approximate with PTT-tail spacing:
    // treat the channel busy inside the TX tail window.
    if (!state.lastTxAt) return true;
    return Date.now() - state.lastTxAt > 800;
  }

  async function handleKissPayload(payload) {
    const result = reassembler.push(payload);
    if (!result || result.duplicate || result.partial || result.error) {
      if (result && result.duplicate) emit("duplicate-frag", result);
      if (result && result.error) setState({ lastError: result.error });
      return;
    }
    if (seenMsgIds.has(result.msgId)) return; // cross-fragment dedupe
    seenMsgIds.add(result.msgId);
    if (seenMsgIds.size > 512)
      seenMsgIds.delete(seenMsgIds.values().next().value);
    let intent = null;
    try {
      intent = await fromWire(result.payloadBytes, config.band, sessionKeyHex);
    } catch (err) {
      setState({ lastError: "decode" });
      return;
    }
    setState({ rxCount: state.rxCount + 1, lastRxAt: Date.now() });
    postSwMessage("HELPHONE_RADIO_RX", {
      msgId: result.msgId,
      type: result.type,
      intent,
    });
    emit("rx", { msgId: result.msgId, msgType: result.type, intent });
  }

  async function connect({ baudRate, filters } = {}) {
    setState({ status: RADIO_STATUS.CONNECTING, lastError: null });
    try {
      const port = await requestRadioPort({ filters });
      transport = createSerialTransport({
        onKissPayload: (payload) => {
          handleKissPayload(payload);
        },
        onDisconnect: () => {
          setState({ status: RADIO_STATUS.DISCONNECTED });
          if (scheduler) scheduler.stop();
        },
        onError: (err) =>
          setState({ lastError: String((err && err.message) || err) }),
      });
      const pref = loadPortPref();
      const baud =
        baudRate || (pref && pref.baudRate) || config.baudRate || DEFAULT_BAUD;
      const info = await transport.open(port, { baudRate: baud });
      scheduler = createScheduler({
        sendFrame: (frame) => {
          if (!transport || !transport.isOpen()) return false;
          transport.write(frame).catch((err) => {
            setState({ lastError: String((err && err.message) || err) });
            return false;
          });
          state.txCount += 1;
          state.lastTxAt = Date.now();
          duck(600);
          return true;
        },
        carrierSense,
        onState: (s) => setState({ txActive: s.txActive, txQueued: s.total }),
      });
      scheduler.start();
      setState({
        status: RADIO_STATUS.LINKED,
        baudRate: baud,
        callsign: config.callsign,
        band: config.band,
        backgroundTxParked: backgroundTxDepth(),
      });
      playTone({ frequency: 660, durationMs: 120, gain: 0.3 });
      flushBackgroundTx();
      return info;
    } catch (err) {
      setState({
        status: RADIO_STATUS.DISCONNECTED,
        lastError: String((err && err.message) || err),
      });
      throw err;
    }
  }

  async function disconnect() {
    if (scheduler) scheduler.stop();
    scheduler = null;
    if (transport) await transport.close();
    transport = null;
    setState({ status: RADIO_STATUS.DISCONNECTED, txActive: false });
  }

  /**
   * Enqueue an intent for TX. Falls back to the background TX park when the
   * page is backgrounded / not linked (foreground flush on next resume).
   */
  function send(
    intent,
    {
      type = MSG.REQUEST,
      prio = PRIO_BY_TYPE[type] ?? PRIO.NEW,
      id = null,
    } = {},
  ) {
    if (state.status !== RADIO_STATUS.LINKED || !scheduler) {
      queueBackgroundTx({ intent, type, prio, id });
      setState({ backgroundTxParked: backgroundTxDepth() });
      emit("tx-parked", { intent, type });
      return { parked: true };
    }
    return sendNow(intent, { type, prio, id });
  }

  async function sendNow(intent, { type, prio, id }) {
    const msgId = id || randomMsgId();
    const { bytes, redacted } = await toWire(
      intent,
      config.band,
      sessionKeyHex,
      {
        from: config.callsign,
        to: config.baseCallsign,
      },
    );
    const frag = fragmentMessage({
      type,
      prio,
      msgId,
      payloadBytes: bytes,
    });
    // SOS gets 2x repeat FEC — every frame transmitted twice.
    const frames =
      prio === PRIO.SOS ? [...frag.frames, ...frag.frames] : frag.frames;
    scheduler.enqueue({ prio, frames, meta: { msgId } });
    setState({ txQueued: scheduler.state().total });
    emit("tx-queued", {
      msgId,
      type,
      prio,
      redactedFields: redacted,
      bytes: bytes.length,
    });
    return { msgId, frames: frag.frames.length, redacted };
  }

  function flushBackgroundTx() {
    const parked = takeBackgroundTx();
    for (const item of parked) {
      sendNow(item.intent, {
        type: item.type,
        prio: item.prio,
        id: item.id,
      }).catch(() => {});
    }
    setState({ backgroundTxParked: backgroundTxDepth() });
    return parked.length;
  }

  function configure(patch = {}) {
    Object.assign(config, patch);
    if (patch.callsign) setState({ callsign: patch.callsign });
    if (patch.band) {
      setState({ band: patch.band });
      config.band = patch.band;
    }
  }

  function subscribe(handler) {
    listeners.push(handler);
    return () => {
      const idx = listeners.indexOf(handler);
      if (idx > 0) listeners.splice(idx, 1);
    };
  }

  return {
    connect,
    disconnect,
    send,
    configure,
    flushBackgroundTx,
    subscribe,
    state: () => ({ ...state }),
    isSupported: isSerialSupported,
    baudOptions: BAUD_OPTIONS,
    MSG,
    PRIO,
  };
}

export async function payloadHash(bytes) {
  return sha256Hex(bytes);
}
