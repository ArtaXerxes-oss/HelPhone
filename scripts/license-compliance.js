#!/usr/bin/env node
// #586 — Dependency license compliance & copyleft legal gate (npm + Cargo).
//
// Extracts license metadata for every direct and transitive dependency:
//   - npm:   package-lock.json (`license` field; falls back to the installed
//            node_modules/<pkg>/package.json, the same source license-checker
//            reads).
//   - Cargo: `cargo metadata` for each Cargo workspace (root + contract/).
// Each license is evaluated as a full SPDX expression (`OR` picks the most
// permissive branch, `AND` the most restrictive), then:
//   - approved   permissive licenses compatible with the MIT/Apache-2.0 codebase
//   - review     weak copyleft / unknown / non-SPDX: warns (fails with --strict)
//   - denied     strong or network copyleft (GPL, AGPL, SSPL, EUPL, ...): FAILS
//                unless the package is listed in LICENSE_EXCEPTIONS.
// Writes `licenses.json`, the attribution manifest shipped with release builds.
//
// Usage:
//   node scripts/license-compliance.js [--out <path>] [--no-write] [--check]
//        [--strict] [--skip-cargo] [--json]
//   --check   fail if the committed licenses.json is stale (CI freshness gate)
//
// Zero runtime dependencies (node built-ins only).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Cargo workspaces to scan, relative to the repo root.
const CARGO_WORKSPACES = ["Cargo.toml", "contract/Cargo.toml"];

export const APPROVED = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "Unlicense",
  "Zlib",
  "BSL-1.0",
  "Python-2.0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "WTFPL",
]);

// Strong / network copyleft — incompatible with shipping a permissive codebase.
export const DENIED_RE =
  /^(A?GPL|SSPL|EUPL|OSL|RPL|CPAL|Sleepycat|CC-BY-(NC|SA|ND)|CC-BY-NC-SA|CC-BY-NC-ND)(-|$)/i;

// Pre-existing, legally reviewed exceptions: name -> justification. The gate
// passes on the current tree but still fails on any NEW denied license.
// Do not extend without legal review (docs/legal-compliance.md).
export const LICENSE_EXCEPTIONS = {
  "npm:@lobstrco/signer-extension-api":
    "GPL-3.0 via @creit-tech/stellar-wallets-kit; browser-extension messaging shim, tracked for replacement (#625)",
};

const RANK = { approved: 0, review: 1, denied: 2 };
const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);
const best = (a, b) => (RANK[a] <= RANK[b] ? a : b);

// Common non-SPDX spellings seen in package metadata.
const ALIASES = {
  "APACHE 2.0": "Apache-2.0",
  "APACHE2": "Apache-2.0",
  "APACHE-2": "Apache-2.0",
  "APACHE LICENSE 2.0": "Apache-2.0",
  "APACHE LICENSE, VERSION 2.0": "Apache-2.0",
  "MIT/X11": "MIT",
  "X11": "MIT",
  "BSD-3": "BSD-3-Clause",
  "NEW BSD": "BSD-3-Clause",
  "SIMPLIFIED BSD": "BSD-2-Clause",
  "PUBLIC DOMAIN": "Unlicense",
};

/** Normalize a single license id (strip license-checker's `*` guess marker). */
export function normalizeId(id) {
  const trimmed = String(id).trim().replace(/\*$/, "");
  return ALIASES[trimmed.toUpperCase()] || trimmed;
}

/** Classify one SPDX license id (optionally carrying a `WITH` exception). */
export function classifyId(id, exception) {
  const norm = normalizeId(id).replace(/\+$/, "");
  if (DENIED_RE.test(norm)) return exception ? "review" : "denied";
  if (APPROVED.has(norm)) return "approved";
  return "review"; // LGPL, MPL, EPL, CDDL, unknown, ...
}

function tokenize(expr) {
  return (
    expr
      .replace(/[()]/g, " $& ")
      // license-checker/old npm style "MIT/Apache-2.0" means OR
      .replace(/\s*\/\s*/g, " OR ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

/** Evaluate an SPDX expression to approved | review | denied.
 *  OR binds looser than AND; `WITH` attaches an exception to the id. */
export function classifyExpression(expr) {
  if (!expr || typeof expr !== "string") return "review";
  const raw = expr.trim();
  if (!raw || /^(UNKNOWN|UNLICENSED|NONE)$/i.test(raw) || /^SEE LICENSE/i.test(raw)) {
    return "review";
  }
  if (ALIASES[raw.toUpperCase()]) return classifyId(raw);
  const tokens = tokenize(raw);
  let i = 0;
  const parseOr = () => {
    let res = parseAnd();
    while (tokens[i] && tokens[i].toUpperCase() === "OR") {
      i++;
      res = best(res, parseAnd());
    }
    return res;
  };
  const parseAnd = () => {
    let res = parseAtom();
    while (tokens[i] && tokens[i].toUpperCase() === "AND") {
      i++;
      res = worst(res, parseAtom());
    }
    return res;
  };
  const parseAtom = () => {
    const tok = tokens[i++];
    if (tok === undefined) return "review";
    if (tok === "(") {
      const res = parseOr();
      if (tokens[i] === ")") i++;
      return res;
    }
    if (tokens[i] && tokens[i].toUpperCase() === "WITH") {
      i++;
      return classifyId(tok, tokens[i++]);
    }
    return classifyId(tok);
  };
  const result = parseOr();
  return i < tokens.length ? "review" : result; // trailing junk -> review
}

function licenseFromPkgJson(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    const ids = pkg.licenses.map((l) => (typeof l === "string" ? l : l?.type)).filter(Boolean);
    if (ids.length) return ids.length > 1 ? `(${ids.join(" OR ")})` : ids[0];
  }
  return undefined;
}

function repoUrl(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  return url ? url.replace(/^git\+/, "").replace(/\.git$/, "") : undefined;
}

/** Collect npm dependencies from a lockfile (v2/v3). Workspace links and the
 *  root project are skipped — they are our own code. */
export function collectNpm(lock, readInstalled = () => null) {
  const out = [];
  for (const [p, meta] of Object.entries(lock.packages || {})) {
    if (!p.startsWith("node_modules/") || meta.link) continue;
    const name = p.slice(p.lastIndexOf("node_modules/") + "node_modules/".length);
    const installed = readInstalled(p);
    const license = meta.license || (installed && licenseFromPkgJson(installed)) || "UNKNOWN";
    out.push({
      ecosystem: "npm",
      name,
      version: meta.version || installed?.version || "?",
      license,
      dev: Boolean(meta.dev),
      repository: repoUrl(installed?.repository),
    });
  }
  return dedupe(out);
}

/** Collect third-party crates from `cargo metadata --format-version 1`. */
export function collectCargo(metadata) {
  return dedupe(
    (metadata.packages || [])
      .filter((p) => p.source) // path/workspace crates have no source
      .map((p) => ({
        ecosystem: "cargo",
        name: p.name,
        version: p.version,
        license: p.license || (p.license_file ? `SEE LICENSE IN ${p.license_file}` : "UNKNOWN"),
        dev: false,
        repository: p.repository || undefined,
      })),
  );
}

function dedupe(list) {
  const seen = new Map();
  for (const d of list) {
    const key = `${d.ecosystem}:${d.name}@${d.version}`;
    const prev = seen.get(key);
    // A package is only dev-only if every occurrence is dev-only.
    if (prev) prev.dev = prev.dev && d.dev;
    else seen.set(key, { ...d });
  }
  return [...seen.values()];
}

/** Classify every dependency and split out the violations. */
export function evaluate(deps, exceptions = LICENSE_EXCEPTIONS) {
  const packages = deps
    .map((d) => {
      let category = classifyExpression(d.license);
      const exception = exceptions[`${d.ecosystem}:${d.name}`];
      if (category === "denied" && exception) category = "excepted";
      return { ...d, category, ...(category === "excepted" ? { exception } : {}) };
    })
    .sort((a, b) =>
      a.ecosystem.localeCompare(b.ecosystem) ||
      a.name.localeCompare(b.name) ||
      a.version.localeCompare(b.version),
    );
  return {
    packages,
    denied: packages.filter((p) => p.category === "denied"),
    review: packages.filter((p) => p.category === "review"),
    excepted: packages.filter((p) => p.category === "excepted"),
  };
}

/** Build the licenses.json attribution manifest (deterministic: no
 *  timestamps, so CI can diff it for freshness). */
export function buildManifest(result) {
  const count = (eco, cat) =>
    result.packages.filter((p) => (!eco || p.ecosystem === eco) && (!cat || p.category === cat)).length;
  const byLicense = {};
  for (const p of result.packages) byLicense[p.license] = (byLicense[p.license] || 0) + 1;
  return {
    $comment:
      "Auto-generated by scripts/license-compliance.js (#586). Do not edit by hand; run `npm run licenses:generate`.",
    policy: {
      projectLicenses: ["MIT", "Apache-2.0"],
      approved: [...APPROVED].sort(),
      denied: "strong/network copyleft: GPL, AGPL, SSPL, EUPL, OSL, RPL, CPAL, Sleepycat, CC-BY-NC/SA/ND",
      review: "weak copyleft (LGPL, MPL, EPL, CDDL) and unrecognised licenses",
      exceptions: LICENSE_EXCEPTIONS,
    },
    summary: {
      total: result.packages.length,
      npm: count("npm"),
      cargo: count("cargo"),
      approved: count(null, "approved"),
      review: count(null, "review"),
      excepted: count(null, "excepted"),
      denied: count(null, "denied"),
      byLicense: Object.fromEntries(Object.entries(byLicense).sort(([a], [b]) => a.localeCompare(b))),
    },
    packages: result.packages.map((p) => {
      const entry = {
        ecosystem: p.ecosystem,
        name: p.name,
        version: p.version,
        license: p.license,
        category: p.category,
      };
      if (p.dev) entry.dev = true;
      if (p.repository) entry.repository = p.repository;
      if (p.exception) entry.exception = p.exception;
      return entry;
    }),
  };
}

function readInstalledPkg(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, lockPath, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function cargoMetadata(manifest) {
  const run = (extra) =>
    execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--locked", "--manifest-path", manifest, ...extra],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  try {
    return JSON.parse(run(["--offline"]));
  } catch {
    return JSON.parse(run([])); // registry index not cached yet
  }
}

function main() {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const outPath = path.resolve(REPO_ROOT, getArg("--out") || "licenses.json");
  const strict = args.includes("--strict");
  const check = args.includes("--check");
  const noWrite = args.includes("--no-write") || check;
  const skipCargo = args.includes("--skip-cargo");
  const asJson = args.includes("--json");

  const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"));
  const deps = collectNpm(lock, readInstalledPkg);

  if (!skipCargo) {
    for (const rel of CARGO_WORKSPACES) {
      const manifest = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(manifest)) continue;
      try {
        deps.push(...collectCargo(cargoMetadata(manifest)));
      } catch (e) {
        console.error(`license-compliance: cargo metadata failed for ${rel}: ${e.message.split("\n")[0]}`);
        console.error("license-compliance: install Rust or pass --skip-cargo (npm-only scan)");
        process.exit(2);
      }
    }
  }

  const result = evaluate(dedupe(deps));
  const manifest = buildManifest(result);
  const serialized = JSON.stringify(manifest, null, 2) + "\n";

  if (check) {
    const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
    if (current !== serialized) {
      console.error(
        `license-compliance: ${path.relative(REPO_ROOT, outPath)} is stale — run \`npm run licenses:generate\` and commit it`,
      );
      process.exitCode = 1;
    }
  }
  if (!noWrite) fs.writeFileSync(outPath, serialized);

  if (asJson) {
    console.log(JSON.stringify(manifest.summary, null, 2));
  } else {
    const s = manifest.summary;
    console.log(
      `license-compliance: ${s.total} packages (npm ${s.npm}, cargo ${s.cargo}) — ` +
        `${s.approved} approved, ${s.review} review, ${s.excepted} excepted, ${s.denied} denied`,
    );
    if (!noWrite) console.log(`license-compliance: attribution manifest -> ${path.relative(REPO_ROOT, outPath)}`);
    for (const p of result.review.slice(0, 15))
      console.log(`REVIEW: ${p.ecosystem}:${p.name}@${p.version} (${p.license})`);
    if (result.review.length > 15) console.log(`... and ${result.review.length - 15} more (see licenses.json)`);
    for (const p of result.excepted)
      console.log(`EXCEPTED: ${p.ecosystem}:${p.name}@${p.version} (${p.license}) — ${p.exception}`);
    for (const p of result.denied)
      console.error(`DENIED: ${p.ecosystem}:${p.name}@${p.version} (${p.license})${p.dev ? " [dev]" : ""}`);
  }

  if (result.denied.length > 0) {
    console.error(
      `license-compliance: FAIL — ${result.denied.length} copyleft license(s) not approved for this permissive codebase (see docs/legal-compliance.md)`,
    );
    process.exit(1);
  }
  if (strict && result.review.length > 0) {
    console.error("license-compliance: FAIL (--strict: licenses pending review)");
    process.exit(1);
  }
  if (!process.exitCode) console.log("license-compliance: OK");
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
