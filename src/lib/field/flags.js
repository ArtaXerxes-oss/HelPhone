/**
 * Client feature flags with versions — single-flag rollback for field
 * features (radio bridge, NFC check-in, hardware SOS, rugged mode).
 * Snapshots feed the incident-bundle generator (ISP-130 flag provenance).
 */

const STORAGE_KEY = "hp_feature_flags";

export const FEATURE_FLAGS = {
  radioBridge: { key: "hp_flag_radio_bridge", version: 1, defaultOn: true },
  nfcCheckIn: { key: "hp_flag_nfc_check_in", version: 1, defaultOn: true },
  hardwareSos: { key: "hp_flag_hardware_sos", version: 1, defaultOn: true },
  ruggedMode: { key: "hp_flag_rugged_mode", version: 1, defaultOn: true },
};

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // best-effort — surface failures are non-fatal here
  }
}

export function isFlagEnabled(flagName) {
  const flag = FEATURE_FLAGS[flagName];
  if (!flag) return false;
  const store = readStore();
  const v = store[flag.key];
  if (typeof v === "boolean") return v;
  return flag.defaultOn;
}

export function setFlag(flagName, enabled) {
  const flag = FEATURE_FLAGS[flagName];
  if (!flag) return false;
  const store = readStore();
  store[flag.key] = !!enabled;
  writeStore(store);
  return true;
}

/** name -> { enabled, version } — collected into incident bundles. */
export function flagSnapshot() {
  const out = {};
  for (const [name, flag] of Object.entries(FEATURE_FLAGS)) {
    out[name] = { enabled: isFlagEnabled(name), version: flag.version };
  }
  return out;
}
