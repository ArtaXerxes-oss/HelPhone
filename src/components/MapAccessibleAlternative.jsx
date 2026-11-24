import React, { useState, useEffect, useRef } from "react";

/**
 * Accessible text-based alternative for the Community Map (ISP-097 / Issue #767).
 *
 * Designed for screen-reader and keyboard-only users who cannot operate the graphical
 * map viewport. Allows full triage, rendezvous selection, and ETA monitoring in <60s
 * using standard Tab + Enter navigation.
 */
export function MapAccessibleAlternative({
  incidents = [],
  selectedIncidentId,
  onSelectIncident,
  etaUpdates = {},
}) {
  const [announcement, setAnnouncement] = useState("");
  const lastAnnouncedRef = useRef({ time: 0, text: "" });

  // Polite live region throttle: at most 1 announcement per 10 seconds to avoid spamming screen readers
  useEffect(() => {
    const activeIncident = incidents.find((i) => i.id === selectedIncidentId);
    if (!activeIncident) return;

    const currentEta = etaUpdates[activeIncident.id] || activeIncident.eta;
    if (!currentEta) return;

    const text = `Update for ${activeIncident.title || activeIncident.id}: Responder ETA is now ${currentEta}`;
    const now = Date.now();

    if (now - lastAnnouncedRef.current.time > 10000 && lastAnnouncedRef.current.text !== text) {
      setAnnouncement(text);
      lastAnnouncedRef.current = { time: now, text };
    }
  }, [etaUpdates, selectedIncidentId, incidents]);

  return (
    <section
      aria-label="Accessible Incident and Rendezvous List"
      role="region"
      className="map-accessible-alternative"
      style={{
        padding: "1rem",
        backgroundColor: "#ECE0CC",
        color: "#234B4E",
        borderRadius: "6px",
        marginBottom: "1rem",
      }}
    >
      <h3 style={{ fontSize: "1.2rem", fontWeight: "bold", marginBottom: "0.5rem" }}>
        Nearby Incidents &amp; Rendezvous Points
      </h3>
      <p style={{ fontSize: "0.9rem", marginBottom: "0.75rem" }}>
        Keyboard alternative to visual map. Use Tab to navigate and Enter or Space to select.
      </p>

      {/* Screen-reader live region for throttled ETA changes */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="a11y-eta-announcer"
        style={{
          position: "absolute",
          width: "1px",
          height: "1px",
          margin: "-1px",
          padding: 0,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          border: 0,
        }}
      >
        {announcement}
      </div>

      <ul
        role="list"
        aria-label="Active emergency incidents"
        style={{ listStyle: "none", padding: 0, margin: 0 }}
      >
        {incidents.map((incident) => {
          const isSelected = incident.id === selectedIncidentId;
          const eta = etaUpdates[incident.id] || incident.eta || "Pending";

          return (
            <li
              key={incident.id}
              role="listitem"
              style={{
                marginBottom: "0.5rem",
                padding: "0.75rem",
                borderRadius: "4px",
                border: isSelected ? "2px solid #234B4E" : "1px solid #C4B59D",
                backgroundColor: isSelected ? "#FDF8F0" : "#FFFFFF",
              }}
            >
              <button
                type="button"
                onClick={() => onSelectIncident?.(incident.id)}
                aria-pressed={isSelected}
                aria-label={`${incident.title || "Emergency Incident"}, Distance: ${incident.distance || "Unknown"}, Status: ${incident.status || "Active"}, ETA: ${eta}`}
                style={{
                  width: "100%",
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  color: "#234B4E",
                  fontFamily: "inherit",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: "bold" }}>{incident.title || incident.id}</span>
                  <span
                    style={{
                      fontSize: "0.85rem",
                      padding: "2px 6px",
                      borderRadius: "3px",
                      backgroundColor: incident.status === "CRITICAL" ? "#FF7A6B" : "#234B4E",
                      color: "#ECE0CC",
                    }}
                  >
                    {incident.status || "ACTIVE"}
                  </span>
                </div>
                <div style={{ fontSize: "0.85rem", marginTop: "0.25rem", color: "#476C6D" }}>
                  <span>Distance: {incident.distance || "350m"}</span> &bull;{" "}
                  <span>Responder ETA: {eta}</span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
