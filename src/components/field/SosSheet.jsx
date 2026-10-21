/**
 * SosSheet — full-screen high-contrast SOS confirmation (ISP-131).
 * Hold-to-confirm (1.2s) defeats pocket bounce; multimodal feedback on
 * commit (vibration + loud tone via the caller). Focus-trapped, Escape
 * cancels, screen-reader announced.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { SOS_HOLD_MS } from "../../hooks/useHardwareSOS";

export default function SosSheet({ open, onCancel, onConfirm }) {
  const dialogRef = useRef(null);
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const holdStartRef = useRef(null);
  const rafRef = useRef(null);

  useFocusTrap(open, dialogRef);
  useEscapeKey(
    open,
    useCallback(() => {
      if (onCancel) onCancel();
    }, [onCancel]),
  );

  const stopHold = useCallback(() => {
    holdStartRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setHolding(false);
    setProgress(0);
  }, []);

  useEffect(() => {
    if (!open) stopHold();
    return stopHold;
  }, [open, stopHold]);

  const tick = useCallback(() => {
    if (holdStartRef.current == null) return;
    const elapsed = Date.now() - holdStartRef.current;
    const p = Math.min(1, elapsed / SOS_HOLD_MS);
    setProgress(p);
    if (p >= 1) {
      holdStartRef.current = null;
      rafRef.current = null;
      setHolding(false);
      setProgress(0);
      if (onConfirm) onConfirm({ source: "sos-sheet", ts: Date.now() });
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [onConfirm]);

  const startHold = useCallback(
    (e) => {
      e.preventDefault();
      if (holdStartRef.current != null) return;
      holdStartRef.current = Date.now();
      setHolding(true);
      rafRef.current = requestAnimationFrame(tick);
    },
    [tick],
  );

  if (!open) return null;

  return (
    <div
      className="hp-sos-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hp-sos-title"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 11000,
        background: "#14100e",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="document"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: "420px",
          width: "100%",
          textAlign: "center",
          color: "#FDFaf5",
          outline: "none",
        }}
      >
        <h2
          id="hp-sos-title"
          style={{
            margin: "0 0 10px",
            fontSize: "28px",
            fontWeight: 900,
            letterSpacing: "1px",
            color: "#FF7A6B",
          }}
        >
          SOS — CONFIRM DISPATCH
        </h2>
        <p
          style={{
            margin: "0 0 28px",
            fontSize: "15px",
            lineHeight: 1.5,
            color: "rgba(253,250,245,0.85)",
          }}
        >
          Hold the button for 1.2 seconds to send an escalated emergency request
          to everyone nearby. Release to cancel.
        </p>

        <button
          type="button"
          aria-label="Hold to confirm SOS dispatch"
          data-testid="sos-hold-button"
          onPointerDown={startHold}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          onKeyDown={(e) => {
            if ((e.key === " " || e.key === "Enter") && !e.repeat) startHold(e);
          }}
          onKeyUp={(e) => {
            if (e.key === " " || e.key === "Enter") stopHold();
          }}
          style={{
            width: "200px",
            height: "200px",
            borderRadius: "50%",
            border: `6px solid ${holding ? "#FFD1CB" : "#FF7A6B"}`,
            background: holding
              ? `conic-gradient(#FF7A6B ${progress * 360}deg, rgba(255,122,107,0.15) 0deg)`
              : "rgba(255,122,107,0.15)",
            color: "#FDFaf5",
            fontSize: "30px",
            fontWeight: 900,
            cursor: "pointer",
            letterSpacing: "2px",
            touchAction: "none",
            userSelect: "none",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: holding ? "0 0 48px rgba(255,122,107,0.6)" : "none",
            transition: "border-color 0.15s, box-shadow 0.15s",
          }}
        >
          SOS
        </button>

        <div
          aria-live="polite"
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            overflow: "hidden",
            clip: "rect(0 0 0 0)",
          }}
        >
          {holding ? `Holding SOS, ${Math.round(progress * 100)} percent` : ""}
        </div>

        <div style={{ marginTop: "28px" }}>
          <button
            type="button"
            onClick={onCancel}
            data-testid="sos-cancel"
            style={{
              minHeight: "48px",
              minWidth: "160px",
              padding: "12px 28px",
              borderRadius: "12px",
              border: "2px solid rgba(253,250,245,0.5)",
              background: "transparent",
              color: "#FDFaf5",
              fontSize: "16px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
