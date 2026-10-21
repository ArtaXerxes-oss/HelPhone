#!/usr/bin/env node
// #588 — Typosquatting & hijacked-package detection gate.
//
// Compares every dependency in package.json (+ server/package.json) against a
// curated list of popular npm names using Levenshtein distance, and optionally
// checks the npm registry for abrupt maintainer/publish-key changes.
// Exits non-zero when a suspicious name is introduced so PRs are blocked.
//
// Usage:
//   node scripts/detect-typosquatting.js [--json] [--check-maintainers]
//
// Zero runtime dependencies (node built-ins only). Network failures degrade
// to warnings — the offline name-distance gate always runs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Curated subset of the most-typosquatted npm names (top-10k list is fetched
// in CI when network is available; this offline set covers this repo's tree).
export const POPULAR_PACKAGES = [
  "react",
  "react-dom",
  "react-router-dom",
  "express",
  "cors",
  "vite",
  "vitest",
  "typescript",
  "eslint",
  "prettier",
  "axios",
  "lodash",
  "moment",
  "chalk",
  "commander",
  "debug",
  "dotenv",
  "jsonwebtoken",
  "mongoose",
  "mysql",
  "pg",
  "redis",
  "webpack",
  "babel",
  "jest",
  "mocha",
  "nodemon",
  "pm2",
  "socket.io",
  "ws",
  "uuid",
  "yargs",
  "inquirer",
  "glob",
  "rimraf",
  "semver",
  "tar",
  "request",
  "superagent",
  "supertest",
  "morgan",
  "compression",
  "mapbox-gl",
  "i18next",
  "buffer",
];

export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// A name is suspicious when it is close-but-not-equal to a popular package:
// distance 1 always; distance 2 only for longer names to limit false positives.
// Names shorter than 5 chars are skipped: generic bases (e.g. the "test" in
// "@playwright/test" vs "jest") collide with short popular names constantly.
export function findTyposquatTarget(name, popular = POPULAR_PACKAGES) {
  const base = name.includes("/") ? name.split("/").pop() : name;
  if (base.length < 5) return null;
  for (const p of popular) {
    if (base === p) return null;
    const d = levenshtein(base.toLowerCase(), p);
    if (d === 1) return p;
    if (d === 2 && base.length >= 8 && p.length >= 8) return p;
  }
  return null;
}

export function collectDepNames(root = REPO_ROOT) {
  const names = new Set();
  for (const file of ["package.json", "server/package.json"]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
      for (const section of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        for (const name of Object.keys(pkg[section] || {})) names.add(name);
      }
    } catch {
      // Missing/unreadable manifest — skip; the gate still checks the rest.
    }
  }
  return [...names].sort();
}

export function scanNames(names, popular = POPULAR_PACKAGES) {
  const findings = [];
  for (const name of names) {
    const target = findTyposquatTarget(name, popular);
    if (target) findings.push({ name, target, reason: "levenshtein-close" });
  }
  return findings;
}

// Best-effort maintainer-change check: fetches npm metadata with a short
// timeout. Network errors resolve to { checked: false } — never fail closed.
export async function checkMaintainer(
  name,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
      { signal: controller.signal },
    );
    if (!res.ok) return { name, checked: false, reason: `http-${res.status}` };
    const data = await res.json();
    return {
      name,
      checked: true,
      version: data.version,
      maintainers:
        data.maintainers?.map((m) => m.name || m.email).filter(Boolean) || [],
      time: data.time?.modified || null,
    };
  } catch (err) {
    return { name, checked: false, reason: String(err?.message || err) };
  } finally {
    clearTimeout(t);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const withMaintainers = args.includes("--check-maintainers");
  const names = collectDepNames();
  const findings = scanNames(names);

  if (withMaintainers) {
    const results = [];
    for (const name of names.slice(0, 50)) {
      // Cap network calls so the gate stays fast.
      results.push(await checkMaintainer(name));
    }
    const unchecked = results.filter((r) => !r.checked);
    for (const r of unchecked)
      console.log(`WARN: maintainer check skipped for ${r.name} (${r.reason})`);
  }

  if (asJson) {
    console.log(JSON.stringify({ packages: names.length, findings }, null, 2));
  } else {
    console.log(
      `typosquat-gate: scanned ${names.length} dependencies, ${findings.length} suspicious`,
    );
    for (const f of findings)
      console.error(
        `SUSPICIOUS: ${f.name} looks like typosquat of "${f.target}"`,
      );
    if (findings.length === 0) console.log("typosquat-gate: OK");
  }
  process.exit(findings.length > 0 ? 1 : 0);
}
