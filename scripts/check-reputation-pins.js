#!/usr/bin/env node
// #945 — Reputation-ranking version alignment gate.
//
// Verifies that:
//   - circuits/reputation/Nargo.toml compiler_version
//   - package.json (@aztec/bb.js, @noir-lang/noir_js) & crypto-pins.json
//   - public/config.json flags.reputationGatedRanking.generation
//   - src/lib/rankingIntegrity.ts EXPECTED_REPUTATION_PINS
// all agree. Fails with exit code 1 on any mismatch.
//
// Zero runtime dependencies (node built-ins only).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function stripRange(v) {
  return typeof v === "string" ? v.trim().replace(/^[\^~]/, "") : "";
}

export function parseNargoCompilerVersion(tomlText) {
  const match = /^compiler_version\s*=\s*"([^"]+)"/m.exec(String(tomlText || ""));
  return match ? match[1] : null;
}

export function parseExpectedPinsFromSource(tsText) {
  const block = /EXPECTED_REPUTATION_PINS[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(String(tsText || ""));
  if (!block) return null;
  const body = block[1];
  const circuitCompilerVersion = /circuitCompilerVersion:\s*['"]([^'"]+)['"]/.exec(body)?.[1] ?? null;
  const bbJs = /bbJs:\s*['"]([^'"]+)['"]/.exec(body)?.[1] ?? null;
  const noirJs = /noirJs:\s*['"]([^'"]+)['"]/.exec(body)?.[1] ?? null;
  const genRaw = /rankingGeneration:\s*(\d+)/.exec(body)?.[1];
  const rankingGeneration = genRaw != null ? Number(genRaw) : null;
  return { circuitCompilerVersion, bbJs, noirJs, rankingGeneration };
}

export function checkReputationAlignment({ nargoToml, pkg, cryptoPins, publicConfig, rankingSource }) {
  const mismatches = [];

  const circuitCompilerVersion = parseNargoCompilerVersion(nargoToml);
  const pkgBbJs = stripRange(pkg?.dependencies?.["@aztec/bb.js"]);
  const pkgNoirJs = stripRange(pkg?.dependencies?.["@noir-lang/noir_js"]);

  const pinMap = new Map((cryptoPins?.pins || []).map((p) => [p.name, p.version]));
  const pinBbJs = pinMap.get("@aztec/bb.js") ?? null;
  const pinNoirJs = pinMap.get("@noir-lang/noir_js") ?? null;

  const flagGen = publicConfig?.flags?.reputationGatedRanking?.generation ?? null;
  const expected = parseExpectedPinsFromSource(rankingSource);

  if (!expected) {
    mismatches.push("Could not parse EXPECTED_REPUTATION_PINS from src/lib/rankingIntegrity.ts");
    return { aligned: false, mismatches };
  }

  if (circuitCompilerVersion !== expected.circuitCompilerVersion) {
    mismatches.push(
      `circuits/reputation/Nargo.toml compiler_version (${circuitCompilerVersion}) != EXPECTED_REPUTATION_PINS (${expected.circuitCompilerVersion})`,
    );
  }
  if (pkgBbJs !== expected.bbJs || pinBbJs !== expected.bbJs) {
    mismatches.push(
      `@aztec/bb.js mismatch: package.json=${pkgBbJs}, crypto-pins.json=${pinBbJs}, rankingIntegrity.ts=${expected.bbJs}`,
    );
  }
  if (pkgNoirJs !== expected.noirJs || pinNoirJs !== expected.noirJs) {
    mismatches.push(
      `@noir-lang/noir_js mismatch: package.json=${pkgNoirJs}, crypto-pins.json=${pinNoirJs}, rankingIntegrity.ts=${expected.noirJs}`,
    );
  }
  if (flagGen !== expected.rankingGeneration) {
    mismatches.push(
      `public/config.json reputationGatedRanking.generation (${flagGen}) != EXPECTED_REPUTATION_PINS (${expected.rankingGeneration})`,
    );
  }

  return { aligned: mismatches.length === 0, mismatches };
}

function main() {
  const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
  const result = checkReputationAlignment({
    nargoToml: read("circuits/reputation/Nargo.toml"),
    pkg: JSON.parse(read("package.json")),
    cryptoPins: JSON.parse(read("crypto-pins.json")),
    publicConfig: JSON.parse(read("public/config.json")),
    rankingSource: read("src/lib/rankingIntegrity.ts"),
  });

  if (!result.aligned) {
    for (const msg of result.mismatches) {
      console.error(`[check-reputation-pins] MISMATCH: ${msg}`);
    }
    process.exit(1);
  }
  console.log("[check-reputation-pins] Reputation circuit, prover pins, and ranking generation aligned.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
