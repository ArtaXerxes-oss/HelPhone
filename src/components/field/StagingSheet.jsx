/**
 * StagingSheet — NFC check-in/out with QR/short-code fallback (ISP-134).
 * Tap-to-scan when NDEFReader exists; otherwise the same idempotent intent
 * is produced from a 6-char short code with geofence corroboration and
 * rate-limiting. Roster shows headcount + unmatched-IN escalation.
 */

import { useState } from "react";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import Input from "../ui/Input";

export default function StagingSheet({ open, onClose, checkIn }) {
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState(null);
  if (!checkIn) return null;

  const { supported, scanning, roster, lastResult, rateLimited, unmatched } =
    checkIn;

  async function submitCode(e) {
    e.preventDefault();
    setCodeError(null);
    const result = await checkIn.submitFallbackCode(code.trim());
    if (result && result.status === "rejected") {
      setCodeError(
        result.reason === "rate-limited"
          ? "Too many attempts — wait a minute."
          : result.reason === "unknown-code"
            ? "Unknown staging code."
            : result.reason === "outside-geofence"
              ? "You must be at the staging area to check in."
              : "Check-in rejected.",
      );
    } else {
      setCode("");
    }
  }

  const statusLine = lastResult
    ? lastResult.status === "accepted"
      ? `Checked IN at ${lastResult.stagingId}`
      : lastResult.status === "duplicate_suppressed"
        ? "Duplicate tap suppressed — one roster slot."
        : `Rejected (${lastResult.reason || "invalid"})`
    : null;

  return (
    <Modal open={open} onClose={onClose} title="Staging check-in" size="md">
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <p
          style={{
            margin: 0,
            fontSize: "13px",
            lineHeight: 1.55,
            color: "rgba(242,236,220,0.7)",
          }}
        >
          Tap the posted staging tag to check IN. Tap again (or an EXIT tag) to
          check OUT. Tags carry no personal data — only the staging ID and a
          rotating HMAC.
        </p>

        {supported ? (
          <Button
            variant={scanning ? "outline" : "primary"}
            onClick={() =>
              scanning ? checkIn.stopScan() : checkIn.startScan()
            }
            style={{ minHeight: "48px" }}
            data-testid="nfc-scan-toggle"
          >
            {scanning ? "Stop scanning" : "Tap tag to check IN"}
          </Button>
        ) : (
          <div
            data-testid="nfc-fallback-notice"
            role="status"
            style={{
              padding: "10px 12px",
              borderRadius: "10px",
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.12)",
              fontSize: "12px",
              color: "rgba(242,236,220,0.75)",
            }}
          >
            This device has no Web NFC — use the staging short code below (also
            printed on the tag QR).
          </div>
        )}

        <form
          onSubmit={submitCode}
          style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}
        >
          <div style={{ flex: 1 }}>
            <Input
              label="Staging short code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="AB12XY"
              maxLength={6}
              error={
                codeError ||
                (rateLimited ? "Rate limited — wait a minute." : "")
              }
              data-testid="nfc-code-input"
            />
          </div>
          <Button
            type="submit"
            variant="teal"
            style={{ minHeight: "48px" }}
            data-testid="nfc-code-submit"
          >
            Check in
          </Button>
        </form>

        {statusLine && (
          <p
            role="status"
            aria-live="polite"
            data-testid="nfc-status"
            style={{
              margin: 0,
              fontSize: "13px",
              fontWeight: 700,
              color: "#7DE2A8",
            }}
          >
            {statusLine}
          </p>
        )}

        <div>
          <div
            style={{
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.8px",
              color: "rgba(242,236,220,0.5)",
              marginBottom: "8px",
            }}
          >
            ROSTER ({roster.filter((r) => r.direction === "IN").length} inside)
          </div>
          {roster.length === 0 ? (
            <p
              style={{
                margin: 0,
                fontSize: "12px",
                color: "rgba(242,236,220,0.45)",
              }}
            >
              No check-ins yet.
            </p>
          ) : (
            <ul
              style={{
                margin: 0,
                padding: 0,
                listStyle: "none",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
              }}
            >
              {roster.slice(0, 8).map((r) => (
                <li
                  key={`${r.responderId}:${r.stagingId}:${r.at}`}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "12px",
                    padding: "6px 8px",
                    borderRadius: "6px",
                    background: "rgba(255,255,255,0.05)",
                    color: "rgba(242,236,220,0.8)",
                  }}
                >
                  <span>{r.stagingId}</span>
                  <span>
                    {r.direction}
                    {r.duplicate_suppressed ? " · dup" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {unmatched.length > 0 && (
          <div
            role="alert"
            data-testid="nfc-unmatched"
            style={{
              padding: "10px 12px",
              borderRadius: "10px",
              background: "rgba(255,122,107,0.14)",
              border: "1px solid rgba(255,122,107,0.4)",
              fontSize: "12px",
              fontWeight: 700,
              color: "#FFB3AA",
            }}
          >
            {unmatched.length} responder(s) checked IN over 30 min ago with no
            OUT — verify headcount before demobilizing.
          </div>
        )}
      </div>
    </Modal>
  );
}
