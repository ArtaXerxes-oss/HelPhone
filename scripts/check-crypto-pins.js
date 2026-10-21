#!/usr/bin/env node
// #779 — cryptographic-core pin gate.
//
// Reads crypto-pins.json and fails when the Barretenberg / Noir stack drifts:
//   - a pinned package resolves to a different version in package-lock.json
//     (any installed copy), or package.json no longer declares it;
//   - members of a coupling (the @noir-lang family) resolve to different versions;
//   - a coupled Cargo.lock crate (if present) differs from its npm counterpart;
//   - a pin has no rationale / review date.
// Pins not reviewed within `staleAfterDays` are reported as stale (escalation
// notice; add --strict-stale to make them fail).
//
// scripts/auto-patch-cve.js uses holdCryptoCore() so crypto-core bumps are
// never applied automatically.
//
// Usage: node scripts/check-crypto-pins.js [--policy <file>] [--strict-stale] [--json]
// Zero runtime dependencies (node built-ins only).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 24 * 60 * 60 * 1000;
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];

/** Every installed copy of `name` in package-lock.json: [{ path, version }]. */
export function installedCopies(lock, name) {
  const out = [];
  for (const [p, meta] of Object.entries(lock?.packages || {})) {
    const idx = p.lastIndexOf("node_modules/");
    if (idx === -1 || meta.link || !meta.version) continue;
    if (p.slice(idx + "node_modules/".length) === name) out.push({ path: p, version: meta.version });
  }
  return out;
}

/** `[[package]]` name/version pairs from Cargo.lock text. */
export function parseCargoLock(text) {
  const out = [];
  for (const block of String(text || "").split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    if (name && version) out.push({ name, version });
  }
  return out;
}

export function declaredIn(pkg, name) {
  return DEP_FIELDS.some((f) => pkg?.[f]?.[name] !== undefined);
}

/**
 * @returns {{ violations: object[], stale: object[] }} each entry has `code`,
 *          `message` (human-readable) and the pin `name` where applicable.
 */
export function checkCryptoPins({ policy, pkg, lock, cargoLock = "", now = new Date() }) {
  const violations = [];
  const stale = [];
  const fail = (code, name, message) => violations.push({ code, name, message });
  const pins = new Map((policy.pins || []).map((p) => [p.name, p]));

  for (const pin of pins.values()) {
    if (!pin.rationale || !pin.reviewed || !pin.version) {
      fail("incomplete-pin", pin.name, `${pin.name}: pin needs 'version', 'rationale' and 'reviewed' in crypto-pins.json.`);
    }
    if (!declaredIn(pkg, pin.name) && !installedCopies(lock, pin.name).length) {
      fail("missing", pin.name, `${pin.name}: pinned at ${pin.version} but neither declared in package.json nor installed in package-lock.json. Remove the pin or restore the dependency.`);
    }
    for (const copy of installedCopies(lock, pin.name)) {
      if (copy.version !== pin.version) {
        fail(
          "drift",
          pin.name,
          `${pin.name}: package-lock.json resolves ${copy.version} at ${copy.path} but crypto-pins.json pins ${pin.version} (${pin.rationale}). A crypto-core bump changes the proof ABI: follow the ABI checklist in docs/security-runbook.md and update crypto-pins.json in the same change.`,
        );
      }
    }
    const age = (now - new Date(pin.reviewed)) / DAY_MS;
    if (Number.isFinite(age) && age > (policy.staleAfterDays ?? 180)) {
      stale.push({
        name: pin.name,
        message: `${pin.name}: pin last reviewed ${pin.reviewed} (${Math.floor(age)} days ago, limit ${policy.staleAfterDays ?? 180}). Re-evaluate: bump, or renew 'reviewed' with a fresh rationale.`,
      });
    }
  }

  for (const c of policy.couplings || []) {
    const seen = new Map();
    for (const name of c.npm || []) {
      for (const copy of installedCopies(lock, name)) seen.set(`${name}@${copy.version}`, copy.version);
    }
    const versions = new Set(seen.values());
    if (versions.size > 1) {
      fail("coupling", c.id, `coupling '${c.id}': members resolve to different versions (${[...seen.keys()].join(", ")}). ${c.description || ""}`.trim());
    }
  }

  const crates = parseCargoLock(cargoLock);
  for (const link of policy.cargoCrates || []) {
    const pin = pins.get(link.pin);
    for (const crate of crates.filter((x) => x.name === link.crate)) {
      if (!pin || crate.version !== pin.version) {
        fail(
          "cargo-drift",
          link.crate,
          `Cargo.lock pins crate ${link.crate} ${crate.version} but ${link.pin} is pinned at ${pin?.version ?? "(no pin)"}. ${link.description || ""}`.trim(),
        );
      }
    }
  }
  return { violations, stale };
}

/**
 * Split an auto-patch plan: crypto-core packages are never auto-applied; they
 * move to `unresolved` with a manual-review reason.
 */
export function holdCryptoCore(plan, policy) {
  const held = new Set(
    (policy.pins || []).filter((p) => policy.tiers?.[p.tier]?.autoMerge === false).map((p) => p.name),
  );
  const patches = [];
  const unresolved = [...plan.unresolved];
  for (const p of plan.patches) {
    if (held.has(p.name)) {
      unresolved.push({
        ...p,
        reason: "crypto-core tier: manual review with the ABI checklist required (crypto-pins.json); never auto-applied",
      });
    } else patches.push(p);
  }
  return { patches, unresolved };
}

export function loadPolicy(file = path.join(REPO_ROOT, "crypto-pins.json")) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main() {
  const args = process.argv.slice(2);
  const pi = args.indexOf("--policy");
  const policy = loadPolicy(pi !== -1 ? path.resolve(args[pi + 1]) : undefined);
  const read = (f) => fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
  const cargoPath = path.join(REPO_ROOT, "Cargo.lock");
  const result = checkCryptoPins({
    policy,
    pkg: JSON.parse(read("package.json")),
    lock: JSON.parse(read("package-lock.json")),
    cargoLock: fs.existsSync(cargoPath) ? read("Cargo.lock") : "",
  });
  const strictStale = args.includes("--strict-stale");
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    for (const v of result.violations) console.error(`crypto-pins: FAIL [${v.code}] ${v.message}`);
    for (const s of result.stale) console.warn(`crypto-pins: STALE ${s.message}`);
    if (!result.violations.length) console.log(`crypto-pins: OK (${policy.pins.length} pin(s), ${result.stale.length} stale)`);
  }
  if (result.violations.length || (strictStale && result.stale.length)) process.exit(1);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
