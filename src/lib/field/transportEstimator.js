/**
 * Transport unification — networkEstimator equivalent for the field stack.
 * Radio is a first-class transport, not "offline".
 */

export const TRANSPORTS = Object.freeze({
  RADIO: "radio",
  WS: "ws",
  OFFLINE: "offline",
});

export function getTransport({ online = true, radioLinked = false } = {}) {
  if (radioLinked) return TRANSPORTS.RADIO;
  if (online) return TRANSPORTS.WS;
  return TRANSPORTS.OFFLINE;
}

export const TRANSPORT_BADGES = Object.freeze({
  radio: { code: "RD", label: "RADIO LINK — 1200 baud" },
  ws: { code: "ON", label: "ONLINE" },
  offline: { code: "OF", label: "OFFLINE — will sync" },
});

export function transportBadge(transport) {
  return TRANSPORT_BADGES[transport] || TRANSPORT_BADGES.offline;
}
