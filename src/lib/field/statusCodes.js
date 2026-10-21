/**
 * Compact 2-letter wire status codes (ISP-135: localized strings compress to
 * codes over 150-byte radio frames). Labels resolve through i18n by code.
 */

export const STATUS_CODES = Object.freeze({
  sos: "S0",
  pending: "PD",
  enroute: "EN",
  arrived: "AR",
  resolved: "RS",
  cancelled: "CC",
  queued: "QU",
  duplicate: "DP",
  radio: "RD",
  online: "ON",
  offline: "OF",
  stagedIn: "IN",
  stagedOut: "OT",
  unknown: "UN",
});

export function statusCode(name) {
  return STATUS_CODES[name] || STATUS_CODES.unknown;
}
