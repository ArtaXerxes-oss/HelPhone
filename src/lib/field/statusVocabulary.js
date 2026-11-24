export const FIELD_STATUS = Object.freeze({
  SOS: "sos",
  PENDING: "pending",
  ENROUTE: "enroute",
  ARRIVED: "arrived",
  RESOLVED: "resolved",
  CANCELLED: "cancelled",
  QUEUED: "queued",
  DUPLICATE: "duplicate",
  RADIO: "radio",
  NFC: "nfc",
  ONLINE: "online",
  DEGRADED: "degraded",
  OFFLINE: "offline",
  UNKNOWN: "unknown",
  STAGED_IN: "staged_in",
  STAGED_OUT: "staged_out",
});

export const FIELD_STATUS_LABELS = Object.freeze({
  sos: "SOS requested",
  pending: "Waiting for responder",
  enroute: "Responder en route",
  arrived: "Responder arrived",
  resolved: "Resolved",
  cancelled: "Cancelled",
  queued: "Queued for delivery",
  duplicate: "Duplicate event suppressed",
  radio: "Radio linked",
  nfc: "NFC check-in active",
  online: "Network online",
  degraded: "Network degraded",
  offline: "Network offline — queued",
  unknown: "Status unknown",
  staged_in: "Staged in",
  staged_out: "Staged out",
});

export function getFieldStatusLabel(status) {
  return FIELD_STATUS_LABELS[status] || FIELD_STATUS_LABELS.unknown;
}

export function isFieldStatus(status) {
  return Object.values(FIELD_STATUS).includes(status);
}
