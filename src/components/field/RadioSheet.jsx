/**
 * RadioSheet — Connect radio (USB) gesture-gated WebSerial pairing sheet
 * (ISP-135). Callsign + baud + band-plan config, TX/RX metering, explicit
 * "RADIO LINK — 1200 baud" badge, and the foreground-only limitation is
 * messaged, never silent.
 */

import { useEffect, useState } from "react";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import Input from "../ui/Input";
import { BAND_MODES } from "../../lib/radio/bandPlan";

const BADGES = {
  disconnected: { label: "RADIO IDLE", color: "rgba(242,236,220,0.55)" },
  connecting: { label: "AUTHORIZING PORT…", color: "#E8C46B" },
  linked: { label: "RADIO LINK — 1200 baud", color: "#7DE2A8" },
};

export default function RadioSheet({ open, onClose, bridge }) {
  const [callsign, setCallsign] = useState(bridge?.state?.callsign || "HEL-04");
  const [baudRate, setBaudRate] = useState(bridge?.state?.baudRate || 19200);
  const [band, setBand] = useState(bridge?.state?.band || BAND_MODES.HAM);
  const [connectError, setConnectError] = useState(null);
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!bridge || typeof bridge.subscribe !== "function") return undefined;
    return bridge.subscribe(() => forceRender((n) => n + 1));
  }, [bridge]);

  if (!bridge) return null;
  const st = bridge.state;
  const badge = BADGES[st.status] || BADGES.disconnected;

  async function handleConnect() {
    setConnectError(null);
    bridge.configure({
      callsign: callsign.trim() || "HEL-04",
      band,
      baudRate: Number(baudRate),
    });
    try {
      await bridge.connect({ baudRate: Number(baudRate) });
    } catch (err) {
      setConnectError(String((err && err.message) || err));
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Field radio bridge" size="md">
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <div
          role="status"
          aria-live="polite"
          data-testid="radio-badge"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "10px 12px",
            borderRadius: "10px",
            background: "rgba(0,0,0,0.25)",
            border: `1px solid ${st.status === "linked" ? "rgba(125,226,168,0.4)" : "rgba(255,255,255,0.1)"}`,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: "10px",
              height: "10px",
              borderRadius: "50%",
              background: badge.color,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: "12px",
              fontWeight: 800,
              letterSpacing: "0.6px",
              color: badge.color,
            }}
          >
            {badge.label}
          </span>
        </div>

        <Input
          label="Callsign"
          value={callsign}
          onChange={(e) => setCallsign(e.target.value.toUpperCase())}
          maxLength={9}
          placeholder="HEL-04"
          hint="Used as the on-air source address (HEL-04>HEL-BASE)."
        />

        <label className="hp-input-label" htmlFor="radio-baud">
          Port baud rate
        </label>
        <select
          id="radio-baud"
          value={baudRate}
          onChange={(e) => setBaudRate(Number(e.target.value))}
          style={{
            minHeight: "44px",
            borderRadius: "8px",
            background: "rgba(255,255,255,0.08)",
            color: "#F4ECDC",
            border: "1px solid rgba(255,255,255,0.18)",
            padding: "0 10px",
            fontSize: "14px",
          }}
        >
          {(bridge.baudOptions || [19200]).map((b) => (
            <option key={b} value={b} style={{ color: "#111" }}>
              {b}
            </option>
          ))}
        </select>

        <label className="hp-input-label" htmlFor="radio-band">
          Band plan
        </label>
        <select
          id="radio-band"
          value={band}
          onChange={(e) => setBand(e.target.value)}
          style={{
            minHeight: "44px",
            borderRadius: "8px",
            background: "rgba(255,255,255,0.08)",
            color: "#F4ECDC",
            border: "1px solid rgba(255,255,255,0.18)",
            padding: "0 10px",
            fontSize: "14px",
          }}
        >
          <option value={BAND_MODES.HAM} style={{ color: "#111" }}>
            Ham (Part 97 — plaintext, PII redacted)
          </option>
          <option value={BAND_MODES.LICENSED} style={{ color: "#111" }}>
            Licensed (Part 90 — encrypted)
          </option>
        </select>

        <p
          style={{
            margin: 0,
            fontSize: "12px",
            lineHeight: 1.5,
            color: "rgba(242,236,220,0.6)",
          }}
        >
          {band === BAND_MODES.HAM
            ? "Ham mode strips names, phones, notes and exact coordinates before transmit — only triage code + grid square leave the device. Encryption is not permitted on amateur bands."
            : "Licensed mode encrypts every frame with compact AEAD (AES-256-GCM). Provision a shared session key before deployment."}
        </p>

        <p
          style={{
            margin: 0,
            fontSize: "12px",
            lineHeight: 1.5,
            color: "rgba(242,236,220,0.6)",
          }}
        >
          The radio link works only while this page stays in the foreground —
          locking the screen or minimizing the PWA stops all traffic (WebSerial
          limitation).
        </p>

        <div
          role="group"
          aria-label="Radio metering"
          style={{
            display: "flex",
            gap: "8px",
            fontSize: "11px",
            color: "rgba(242,236,220,0.65)",
          }}
        >
          <span data-testid="radio-tx-count">TX {st.txCount}</span>
          <span data-testid="radio-rx-count">RX {st.rxCount}</span>
          <span data-testid="radio-queue">QUEUED {st.txQueued}</span>
          {st.backgroundTxParked > 0 && (
            <span data-testid="radio-parked">
              {st.backgroundTxParked} PARKED (foreground flush)
            </span>
          )}
        </div>

        {connectError && (
          <p
            role="alert"
            style={{ margin: 0, fontSize: "12px", color: "#FF7A6B" }}
          >
            {connectError}
          </p>
        )}
        {st.lastError && !connectError && (
          <p
            role="alert"
            style={{ margin: 0, fontSize: "12px", color: "#FF7A6B" }}
          >
            Last radio error: {st.lastError}
          </p>
        )}

        {st.status === "linked" ? (
          <Button
            variant="outline"
            onClick={() => bridge.disconnect()}
            style={{ minHeight: "48px" }}
          >
            Disconnect radio
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={handleConnect}
            disabled={st.status === "connecting"}
            style={{ minHeight: "48px" }}
            data-testid="radio-connect"
          >
            {st.status === "connecting"
              ? "Waiting for port…"
              : "Connect radio (USB)"}
          </Button>
        )}
      </div>
    </Modal>
  );
}
