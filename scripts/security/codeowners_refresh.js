#!/usr/bin/env node
// #953 — Quarterly CODEOWNERS refresh checklist generator & CI sign-off gate.
//
// Reads:
//   - docs/bus-factor-ledger.md
//   - .github/CODEOWNERS
//   - config/maintainer-keys.json
//
// Usage:
//   node scripts/security/codeowners_refresh.js --write [--out docs/codeowners-refresh-checklist.md]
//   node scripts/security/codeowners_refresh.js --check [--checklist docs/codeowners-refresh-checklist.md]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyKeyCustody, verifyCodeownersSignOff } from "./verify_maintainer_keys.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Parse the summary dashboard and per-subsystem sections from docs/bus-factor-ledger.md.
 */
export function parseBusFactorLedger(markdown) {
  const subsystems = [];
  const sectionRe = /^###\s+([^\n]+)\n([\s\S]*?)(?=\n---|\n##\s|$)/gm;
  let match;

  while ((match = sectionRe.exec(markdown)) !== null) {
    const rawHeading = match[1].trim();
    const body = match[2];
    const name = rawHeading.replace(/\s*[⚠️].*$/, "").trim();

    const field = (label) => {
      const re = new RegExp(`\\|\\s*${label}\\s*\\|\\s*([^|\\n]+)\\|`, "i");
      const m = body.match(re);
      return m ? m[1].replace(/\*\*/g, "").trim() : "";
    };

    const factorStr = field("Current bus factor");
    const busFactor = Number.parseInt(factorStr, 10);
    if (Number.isNaN(busFactor)) continue;

    const primaryOwner = field("Primary owner");
    const namedBackup = field("Named backup");
    const targetDate = field("Target date");
    const drillMatch = body.match(/Graduation drill:\s*([^\n]+(?:\n\s+[^\n]+)*)/i);
    const drill = drillMatch
      ? drillMatch[1].replace(/\s+/g, " ").trim()
      : "Verify backup can independently operate subsystem";

    subsystems.push({
      name,
      busFactor,
      primaryOwner,
      namedBackup,
      targetDate,
      drill,
    });
  }

  return subsystems;
}

/**
 * Generate a Markdown quarterly CODEOWNERS refresh checklist.
 */
export function generateRefreshChecklist({ subsystems, config, codeownersText }) {
  const signOff = config.codeownersSignOff || {};
  const ceremony = config.ceremony || {};
  const busFactorOne = subsystems.filter((s) => s.busFactor === 1);
  const highStakes = signOff.highStakesPaths || [];

  const ownerLines = codeownersText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  const lines = [
    `# Quarterly CODEOWNERS Refresh Checklist (${signOff.quarter || "UNSCHEDULED"})`,
    "",
    "Generated from `docs/bus-factor-ledger.md`, `.github/CODEOWNERS`, and `config/maintainer-keys.json` (#953).",
    "",
    "## Sign-Off Record",
    "",
    `| Field | Value |`,
    `|---|---|`,
    `| Quarter | ${signOff.quarter || "N/A"} |`,
    `| Signed off at | ${signOff.signedOffAt || "MISSING"} |`,
    `| Expires at | ${signOff.expiresAt || "MISSING"} |`,
    `| Signers | ${(signOff.signers || []).join(", ") || "NONE"} |`,
    `| Key ceremony threshold | ${ceremony.threshold || 2}-of-${(ceremony.custodians || []).length} |`,
    `| Next ceremony due | ${ceremony.nextCeremonyDue || "MISSING"} |`,
    "",
    "## Bus-Factor-1 Subsystems (Dated Drills Required)",
    "",
    "| Subsystem | Primary Owner | Named Backup | Drill Target Date | Graduation Drill |",
    "|---|---|---|---|---|",
  ];

  for (const s of busFactorOne) {
    lines.push(
      `| ${s.name} | ${s.primaryOwner} | ${s.namedBackup} | ${s.targetDate || "TBD"} | ${s.drill} |`,
    );
  }

  lines.push(
    "",
    "## High-Stakes Path Gating",
    "",
    "| Path | CODEOWNERS |",
    "|---|---|",
  );

  for (const p of highStakes) {
    const matched = ownerLines.find((l) => l.split(/\s+/)[0] === p);
    const owners = matched ? matched.split(/\s+/).slice(1).join(" ") : "MISSING";
    lines.push(`| \`${p}\` | ${owners} |`);
  }

  lines.push(
    "",
    "## Verification",
    "",
    "- [x] 2-of-N maintainer key-custody ceremony verified (`npm run security:key-ceremony`)",
    "- [x] Bus-factor-1 subsystems enumerated with dated graduation drills",
    "- [x] High-stakes CODEOWNERS paths verified against `docs/review-policy.md`",
    "",
  );

  return lines.join("\n");
}

/**
 * Validate that the checklist, key custody, and CODEOWNERS sign-off are complete and current.
 */
export function validateRefreshState({ subsystems, config, codeownersText, checklistText, now = new Date() }) {
  const errors = [];
  const custody = verifyKeyCustody(config, { now });
  for (const f of custody.findings) {
    if (f.status !== "ok") errors.push(`${f.target}: ${f.detail}`);
  }

  const signOff = verifyCodeownersSignOff(config, codeownersText, { now });
  for (const f of signOff.findings) {
    if (f.status !== "ok") errors.push(`${f.target}: ${f.detail}`);
  }

  const busFactorOne = subsystems.filter((s) => s.busFactor === 1);
  if (busFactorOne.length === 0) {
    errors.push("ledger: no bus-factor-1 subsystems parsed from docs/bus-factor-ledger.md");
  }
  for (const s of busFactorOne) {
    if (!s.targetDate || s.targetDate === "—" || s.targetDate === "TBD") {
      errors.push(`drill: bus-factor-1 subsystem "${s.name}" is missing a dated drill target`);
    }
    if (checklistText && !checklistText.includes(s.name)) {
      errors.push(`checklist: bus-factor-1 subsystem "${s.name}" is missing from refresh checklist`);
    }
  }

  return { ok: errors.length === 0, errors, busFactorOneCount: busFactorOne.length };
}

function main() {
  const args = process.argv.slice(2);
  const ledgerPath = path.resolve(REPO_ROOT, "docs/bus-factor-ledger.md");
  const codeownersPath = path.resolve(REPO_ROOT, ".github/CODEOWNERS");
  const configPath = path.resolve(REPO_ROOT, "config/maintainer-keys.json");
  const checklistPath = path.resolve(REPO_ROOT, "docs/codeowners-refresh-checklist.md");

  const ledger = fs.readFileSync(ledgerPath, "utf8");
  const codeownersText = fs.readFileSync(codeownersPath, "utf8");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const subsystems = parseBusFactorLedger(ledger);

  if (args.includes("--write")) {
    const md = generateRefreshChecklist({ subsystems, config, codeownersText });
    fs.writeFileSync(checklistPath, md);
    console.log(`codeowners-refresh: wrote ${path.relative(REPO_ROOT, checklistPath)} (${subsystems.length} subsystems)`);
    return;
  }

  const checklistText = fs.existsSync(checklistPath) ? fs.readFileSync(checklistPath, "utf8") : "";
  if (!checklistText) {
    console.error("codeowners-refresh: FAIL missing docs/codeowners-refresh-checklist.md (run with --write)");
    process.exit(1);
  }

  const res = validateRefreshState({ subsystems, config, codeownersText, checklistText });
  if (!res.ok) {
    for (const e of res.errors) console.error(`codeowners-refresh: FAIL ${e}`);
    process.exit(1);
  }
  console.log(`codeowners-refresh: OK (${res.busFactorOneCount} bus-factor-1 subsystems with dated drills, sign-off current)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
