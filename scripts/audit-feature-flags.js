#!/usr/bin/env node
// #944 — Flag-governance audit & staged rollout gate for ZK/ranking flags.
//
// Enforces:
//   - Every flag has an explicit `owner`, non-expired `expiresAt`, and valid `canaryStage`
//   - Flag flips/promotions are recorded in `auditLog` with `actor` and `reason`
//   - ZK/ranking flags (`requiresPinAlignment: true`) follow the staged promotion
//     sequence (off -> canary_10 -> canary_50 -> ga_100) and cannot be promoted
//     while reputation prover pins are misaligned
//
// Usage:
//   node scripts/audit-feature-flags.js --check
//   node scripts/audit-feature-flags.js --promote <flagKey> --stage <stage> --actor <handle> --reason <text>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkReputationAlignment } from "./check-reputation-pins.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CANARY_STAGES = Object.freeze(["off", "canary_10", "canary_50", "ga_100"]);
export const STAGE_PERCENTAGE = Object.freeze({
  off: 0,
  canary_10: 10,
  canary_50: 50,
  ga_100: 100,
});

/**
 * Audit feature-flag ownership, expiry dates, canary stages, and audit-log integrity.
 */
export function auditFeatureFlags(config, { now = new Date() } = {}) {
  const findings = [];
  const flags = config?.flags || {};

  for (const [key, flag] of Object.entries(flags)) {
    if (!flag.owner || !String(flag.owner).trim()) {
      findings.push({ flagKey: key, level: "fail", reason: "missing flag owner" });
    }
    if (!flag.expiresAt) {
      findings.push({ flagKey: key, level: "fail", reason: "missing expiresAt governance date" });
    } else {
      const exp = new Date(flag.expiresAt);
      if (Number.isNaN(exp.getTime()) || exp <= now) {
        findings.push({
          flagKey: key,
          level: "fail",
          reason: `stale flag: expired at ${flag.expiresAt}`,
        });
      }
    }

    if (!flag.canaryStage || !CANARY_STAGES.includes(flag.canaryStage)) {
      findings.push({
        flagKey: key,
        level: "fail",
        reason: `invalid or missing canaryStage "${flag.canaryStage}"`,
      });
    } else {
      const expectedPct = STAGE_PERCENTAGE[flag.canaryStage];
      if (flag.rolloutPercentage !== expectedPct) {
        findings.push({
          flagKey: key,
          level: "fail",
          reason: `rolloutPercentage (${flag.rolloutPercentage}) does not match canaryStage ${flag.canaryStage} (${expectedPct})`,
        });
      }
    }
  }

  const auditLog = Array.isArray(config?.auditLog) ? config.auditLog : [];
  for (let i = 0; i < auditLog.length; i++) {
    const ev = auditLog[i];
    if (!ev.flagKey || !ev.actor || !ev.reason || !ev.timestamp) {
      findings.push({
        flagKey: ev.flagKey || `auditLog[${i}]`,
        level: "fail",
        reason: "auditLog event missing required actor, reason, flagKey, or timestamp",
      });
    }
  }

  return { ok: findings.length === 0, findings };
}

/**
 * Promote (or roll back to `off`) a feature flag with pin-alignment & audit-log enforcement.
 */
export function promoteFlag({
  config,
  flagKey,
  targetStage,
  actor,
  reason,
  pinAlignment,
  now = new Date(),
}) {
  if (!CANARY_STAGES.includes(targetStage)) {
    throw new Error(`Invalid targetStage "${targetStage}". Expected one of: ${CANARY_STAGES.join(", ")}`);
  }
  if (!actor || !String(actor).trim()) {
    throw new Error("Flag flip/promotion requires a non-empty actor");
  }
  if (!reason || !String(reason).trim()) {
    throw new Error("Flag flip/promotion requires a non-empty reason");
  }

  const next = structuredClone(config);
  const flag = next.flags?.[flagKey];
  if (!flag) {
    throw new Error(`Unknown feature flag "${flagKey}"`);
  }

  const fromStage = flag.canaryStage || "off";
  const fromIdx = CANARY_STAGES.indexOf(fromStage);
  const toIdx = CANARY_STAGES.indexOf(targetStage);

  if (targetStage !== "off" && toIdx !== fromIdx + 1 && toIdx !== fromIdx) {
    throw new Error(
      `Invalid promotion sequence for "${flagKey}": ${fromStage} -> ${targetStage} (must promote one stage at a time)`,
    );
  }

  if (flag.requiresPinAlignment && targetStage !== "off") {
    if (!pinAlignment || !pinAlignment.aligned) {
      const details = pinAlignment?.mismatches?.join("; ") || "reputation prover pins are misaligned";
      throw new Error(`Cannot promote "${flagKey}" while pins are misaligned: ${details}`);
    }
  }

  flag.canaryStage = targetStage;
  flag.rolloutPercentage = STAGE_PERCENTAGE[targetStage];
  flag.enabled = targetStage !== "off";
  next.updatedAt = now.toISOString();

  next.auditLog = Array.isArray(next.auditLog) ? next.auditLog : [];
  next.auditLog.push({
    timestamp: now.toISOString(),
    flagKey,
    actor: String(actor).trim(),
    reason: String(reason).trim(),
    fromStage,
    toStage: targetStage,
    pinsAligned: pinAlignment ? Boolean(pinAlignment.aligned) : undefined,
  });

  return next;
}

function loadPinAlignment(configOverride) {
  const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
  return checkReputationAlignment({
    nargoToml: read("circuits/reputation/Nargo.toml"),
    pkg: JSON.parse(read("package.json")),
    cryptoPins: JSON.parse(read("crypto-pins.json")),
    publicConfig: configOverride ?? JSON.parse(read("public/config.json")),
    rankingSource: read("src/lib/rankingIntegrity.ts"),
  });
}

function main() {
  const args = process.argv.slice(2);
  const configPath = path.join(REPO_ROOT, "public/config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  const promoteIdx = args.indexOf("--promote");
  if (promoteIdx !== -1) {
    const getArg = (flag) => {
      const i = args.indexOf(flag);
      return i !== -1 ? args[i + 1] : undefined;
    };
    const flagKey = args[promoteIdx + 1];
    const targetStage = getArg("--stage");
    const actor = getArg("--actor");
    const reason = getArg("--reason");
    const pinAlignment = loadPinAlignment(config);

    const updated = promoteFlag({ config, flagKey, targetStage, actor, reason, pinAlignment });
    fs.writeFileSync(configPath, JSON.stringify(updated, null, 2) + "\n");
    console.log(`audit-feature-flags: promoted ${flagKey} to ${targetStage} by ${actor}`);
    return;
  }

  const audit = auditFeatureFlags(config);
  const pinAlignment = loadPinAlignment(config);
  const errors = [...audit.findings.map((f) => `${f.flagKey}: ${f.reason}`)];

  if (!pinAlignment.aligned) {
    for (const m of pinAlignment.mismatches) {
      errors.push(`pin-alignment: ${m}`);
    }
  }

  if (errors.length) {
    for (const e of errors) console.error(`audit-feature-flags: FAIL ${e}`);
    process.exit(1);
  }

  console.log(
    `audit-feature-flags: OK (${Object.keys(config.flags || {}).length} flags governed, pins aligned)`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
