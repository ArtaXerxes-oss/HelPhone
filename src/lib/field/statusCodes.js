import { FIELD_STATUS, getFieldStatusLabel } from './statusVocabulary.js';

/**
 * Compact 2-letter wire status codes (ISP-135: localized strings compress to
 * codes over 150-byte radio frames). Labels resolve through i18n by code.
 */

export const STATUS_CODES = Object.freeze({
  [FIELD_STATUS.SOS]: "S0",
  [FIELD_STATUS.PENDING]: "PD",
  [FIELD_STATUS.ENROUTE]: "EN",
  [FIELD_STATUS.ARRIVED]: "AR",
  [FIELD_STATUS.RESOLVED]: "RS",
  [FIELD_STATUS.CANCELLED]: "CC",
  [FIELD_STATUS.QUEUED]: "QU",
  [FIELD_STATUS.DUPLICATE]: "DP",
  [FIELD_STATUS.RADIO]: "RD",
  [FIELD_STATUS.NFC]: "NF",
  [FIELD_STATUS.ONLINE]: "ON",
  [FIELD_STATUS.DEGRADED]: "DG",
  [FIELD_STATUS.OFFLINE]: "OF",
  [FIELD_STATUS.STAGED_IN]: "IN",
  [FIELD_STATUS.STAGED_OUT]: "OT",
  [FIELD_STATUS.UNKNOWN]: "UN",
});

export function statusCode(name) {
  return STATUS_CODES[name] || STATUS_CODES[FIELD_STATUS.UNKNOWN];
}

export function statusLabel(name) {
  return getFieldStatusLabel(name);
}
