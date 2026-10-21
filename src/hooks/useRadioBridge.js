/**
 * useRadioBridge — React binding for createRadioBridge. Keeps a single
 * bridge instance per page, mirrors its state into React state, flushes
 * parked background TX intents on resume, and closes the port on unmount
 * (single-flag rollback via FEATURE_FLAGS.radioBridge).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isFlagEnabled } from "../lib/field/flags";
import { createRadioBridge } from "../lib/radio/radioBridge";
import { BAND_MODES } from "../lib/radio/bandPlan";

export function useRadioBridge({
  callsign = "HEL-04",
  band = BAND_MODES.HAM,
} = {}) {
  const enabled = isFlagEnabled("radioBridge");
  const [state, setState] = useState({
    status: "disconnected",
    band,
    callsign,
    baudRate: 19200,
    txQueued: 0,
    txActive: false,
    rxCount: 0,
    txCount: 0,
    lastRxAt: null,
    lastTxAt: null,
    lastError: null,
    backgroundTxParked: 0,
  });
  const [events, setEvents] = useState([]);
  const bridgeRef = useRef(null);

  if (!bridgeRef.current && enabled) {
    bridgeRef.current = createRadioBridge({
      callsign,
      band,
      onEvent: (evt) => {
        setState(evt.state);
        if (
          evt.type === "rx" ||
          evt.type === "tx-queued" ||
          evt.type === "tx-parked"
        ) {
          setEvents((prev) => [evt, ...prev].slice(0, 20));
        }
      },
    });
  }

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && bridgeRef.current) {
        bridgeRef.current.flushBackgroundTx();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (bridgeRef.current) bridgeRef.current.disconnect();
    };
  }, []);

  const connect = useCallback(async (opts) => {
    if (!bridgeRef.current) return null;
    return bridgeRef.current.connect(opts);
  }, []);

  const disconnect = useCallback(async () => {
    if (bridgeRef.current) await bridgeRef.current.disconnect();
  }, []);

  const send = useCallback((intent, opts) => {
    if (!bridgeRef.current) return { parked: true };
    return bridgeRef.current.send(intent, opts);
  }, []);

  const configure = useCallback((patch) => {
    if (bridgeRef.current) bridgeRef.current.configure(patch);
  }, []);

  return {
    enabled,
    supported: bridgeRef.current ? bridgeRef.current.isSupported() : false,
    state,
    events,
    connect,
    disconnect,
    send,
    configure,
    baudOptions: bridgeRef.current ? bridgeRef.current.baudOptions : [],
  };
}
