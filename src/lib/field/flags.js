/**
 * Client feature flags with versions — single-flag rollback for field
 * features (radio bridge, NFC check-in, hardware SOS, rugged mode).
 * Routed through the unified remote+field resolver (#943) so incident bundles
 * record both provenance layers with their versions.
 */

import {
  FLAG_PRECEDENCE,
  currentFlagVersion,
  defaultEvaluator,
  resolveUnifiedFlag,
} from "../featureFlags";

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

function resolveFieldFlag(flagName, userContext, evaluator = defaultEvaluator) {
  const flag = FEATURE_FLAGS[flagName];
  const store = readStore();
  const rawOverride = flag ? store[flag.key] : undefined;
  return resolveUnifiedFlag(
    flagName,
    {
      override: typeof rawOverride === "boolean" ? rawOverride : null,
      defaultOn: flag ? flag.defaultOn : undefined,
      version: flag ? flag.version : null,
    },
    userContext,
    evaluator,
  );
}

export function isFlagEnabled(flagName, userContext, evaluator = defaultEvaluator) {
  if (!FEATURE_FLAGS[flagName]) return false;
  return resolveFieldFlag(flagName, userContext, evaluator).enabled;
}

export function setFlag(flagName, enabled) {
  const flag = FEATURE_FLAGS[flagName];
  if (!flag) return false;
  const store = readStore();
  store[flag.key] = !!enabled;
  writeStore(store);
  return true;
}

/**
 * name -> { enabled, version, source, provenance: { remote, field } }
 * Collected into incident bundles with both provenance layers and versions.
 */
export function flagSnapshot(userContext, evaluator = defaultEvaluator) {
  const out = {};
  for (const [name, flag] of Object.entries(FEATURE_FLAGS)) {
    const resolved = resolveFieldFlag(name, userContext, evaluator);
    out[name] = {
      enabled: resolved.enabled,
      version: flag.version,
      source: resolved.source,
      provenance: resolved.provenance,
    };
  }
  return out;
}

/** Full incident-bundle provenance envelope for remote + field flag layers. */
export function flagProvenanceBundle(userContext, evaluator = defaultEvaluator) {
  return {
    precedence: FLAG_PRECEDENCE,
    remoteConfigVersion: evaluator.getConfig()?.version ?? null,
    killSwitchVersion: currentFlagVersion(),
    flags: flagSnapshot(userContext, evaluator),
  };
}
