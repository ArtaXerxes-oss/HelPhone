#!/usr/bin/env node
// #540 — Supply chain security & license auditor.
//
// Audits every package in package-lock.json and server/package-lock.json for:
//   1. License compliance — approved permissive licenses pass, unauthorized
//      copyleft (GPL/AGPL/SSPL/EUPL/...) fails unless tracked in EXCEPTIONS.
//   2. Install-script risk — packages with lifecycle scripts (preinstall /
//      install / postinstall) must be allowlisted; when installed, the script
//      bodies are scanned for download-and-execute / obfuscation patterns.
//   3. Hijack indicators — tarballs resolved from an untrusted registry host,
//      insecure http:// URLs, git/file sources, or missing / weak integrity.
//
// Writes a deterministic licenses.json report (no timestamps) so CI can verify
// it is committed and fresh with --check.
//
// Usage:
//   node scripts/audit-deps.js [--lock <path>]... [--out <path>] [--no-write]
//                              [--check] [--strict] [--json]
//
// Zero runtime dependencies (node built-ins only). Shares its license policy
// with scripts/security/license_compliance.js so both gates agree.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXCEPTIONS, classify } from "./security/license_policy.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const DEFAULT_LOCKS = ["package-lock.json", "server/package-lock.json"];
export const DEFAULT_REPORT = "licenses.json";

// Additional copyleft families denied on top of the shared GPL/AGPL policy.
export const EXTRA_DENIED_RE = /^(SSPL|EUPL|OSL|CPAL|RPL)(\W|$)/i;

// Registries whose tarballs we accept. JSR's npm-compat registry is used by
// @creit-tech/stellar-wallets-kit.
export const TRUSTED_REGISTRIES = new Set(["registry.npmjs.org", "npm.jsr.io"]);

// Packages with known-legitimate lifecycle scripts (native addon builds and
// prebuilt-binary fetchers). Anything not listed here fails the gate.
export const INSTALL_SCRIPT_ALLOWLIST = {
  esbuild: "postinstall validates the platform-specific binary",
  fsevents: "macOS file-watch native addon build",
  "msgpackr-extract": "prebuilt native msgpack decoder (node-gyp-build)",
  secp256k1: "native secp256k1 addon build",
  "utf-8-validate": "optional native ws accelerator",
  bufferutil: "optional native ws accelerator",
  msw: "postinstall copies the service worker into public/",
  "@reown/appkit": "wallet-kit transitive; postinstall prints a notice",
};

// Patterns that make a lifecycle script suspicious regardless of allowlist.
export const SUSPICIOUS_SCRIPT_PATTERNS = [
  { id: "download-exec", re: /\b(curl|wget)\b[^|;&]*\|\s*(sh|bash|node)\b/i },
  { id: "remote-url", re: /https?:\/\/(?!registry\.npmjs\.org)/i },
  { id: "eval", re: /\b(eval|new Function)\s*\(/ },
  { id: "base64-decode", re: /(atob|base64\s+-d|Buffer\.from\([^)]*base64)/i },
  { id: "powershell", re: /\bpowershell\b/i },
  {
    id: "env-exfil",
    re: /process\.env[\s\S]*\b(fetch|https?\.request|curl)\b/i,
  },
];

const LIFECYCLE = ["preinstall", "install", "postinstall"];

export function packageNameFromPath(lockPath) {
  const i = lockPath.lastIndexOf("node_modules/");
  return i === -1 ? lockPath : lockPath.slice(i + "node_modules/".length);
}

// Flatten a lockfile into audit entries. The root ("") entry, workspace
// folders and symlinked workspace links have no registry tarball and are
// skipped — they are first-party code.
export function readLockPackages(lockFile, root = REPO_ROOT) {
  const abs = path.resolve(root, lockFile);
  const lock = JSON.parse(fs.readFileSync(abs, "utf8"));
  const entries = [];
  for (const [p, meta] of Object.entries(lock.packages || {})) {
    if (!p || meta.link || !p.includes("node_modules/")) continue;
    entries.push({
      lock: lockFile,
      path: p,
      name: packageNameFromPath(p),
      version: meta.version || "?",
      license: typeof meta.license === "string" ? meta.license : "UNKNOWN",
      dev: Boolean(meta.dev),
      hasInstallScript: Boolean(meta.hasInstallScript),
      resolved: meta.resolved,
      integrity: meta.integrity,
    });
  }
  return entries.sort(
    (a, b) => a.path.localeCompare(b.path) || a.lock.localeCompare(b.lock),
  );
}

export function classifyLicense(license, pkgPath, exceptions = EXCEPTIONS) {
  let status = classify(license);
  if (status !== "denied" && EXTRA_DENIED_RE.test(license || ""))
    status = "denied";
  if (status === "denied" && exceptions[pkgPath]) status = "excepted";
  return status;
}

export function auditLicenses(entries, exceptions = EXCEPTIONS) {
  const result = { approved: [], review: [], excepted: [], denied: [] };
  for (const e of entries) {
    const status = classifyLicense(e.license, e.path, exceptions);
    result[status].push({ ...e, status });
  }
  return result;
}

export function scanScriptBody(body) {
  return SUSPICIOUS_SCRIPT_PATTERNS.filter(({ re }) => re.test(body)).map(
    ({ id }) => id,
  );
}

// Read lifecycle script bodies from an installed package.json, if present.
export function readInstalledScripts(entry, root = REPO_ROOT) {
  const base = entry.lock.includes("/") ? path.dirname(entry.lock) : "";
  const file = path.join(root, base, entry.path, "package.json");
  try {
    const scripts = JSON.parse(fs.readFileSync(file, "utf8")).scripts || {};
    return LIFECYCLE.filter((k) => typeof scripts[k] === "string").map((k) => ({
      hook: k,
      body: scripts[k],
    }));
  } catch {
    return [];
  }
}

export function auditInstallScripts(
  entries,
  {
    allowlist = INSTALL_SCRIPT_ALLOWLIST,
    readScripts = (e) => readInstalledScripts(e),
  } = {},
) {
  const findings = [];
  for (const e of entries) {
    if (!e.hasInstallScript) continue;
    if (!Object.hasOwn(allowlist, e.name))
      findings.push({ ...e, kind: "unlisted-install-script" });
    for (const { hook, body } of readScripts(e)) {
      const hits = scanScriptBody(body);
      if (hits.length)
        findings.push({ ...e, kind: "suspicious-install-script", hook, hits });
    }
  }
  return findings;
}

export function auditSources(entries, trusted = TRUSTED_REGISTRIES) {
  const findings = [];
  for (const e of entries) {
    if (!e.resolved) {
      findings.push({ ...e, kind: "missing-resolved" });
      continue;
    }
    let url;
    try {
      url = new URL(e.resolved);
    } catch {
      findings.push({ ...e, kind: "untrusted-source", detail: e.resolved });
      continue;
    }
    if (url.protocol === "http:")
      findings.push({ ...e, kind: "insecure-transport", detail: e.resolved });
    else if (url.protocol !== "https:" || !trusted.has(url.hostname))
      findings.push({ ...e, kind: "untrusted-source", detail: e.resolved });
    if (!e.integrity) findings.push({ ...e, kind: "missing-integrity" });
    else if (!e.integrity.startsWith("sha512-"))
      findings.push({ ...e, kind: "weak-integrity", detail: e.integrity });
  }
  return findings;
}

// Deterministic report: no timestamps, sorted, so `--check` can diff it.
export function buildReport(entries, licenses) {
  return {
    generatedBy: "scripts/audit-deps.js (#540)",
    policy: {
      approved: "MIT, Apache-2.0, BSD-*, ISC (and equivalent permissives)",
      denied: "GPL, AGPL, SSPL, EUPL, OSL, CPAL, RPL unless in EXCEPTIONS",
    },
    summary: {
      total: entries.length,
      approved: licenses.approved.length,
      review: licenses.review.length,
      excepted: licenses.excepted.length,
      denied: licenses.denied.length,
    },
    exceptions: EXCEPTIONS,
    packages: entries.map((e) => ({
      lock: e.lock,
      path: e.path,
      version: e.version,
      license: e.license,
      status: classifyLicense(e.license, e.path),
    })),
  };
}

export function runAudit(locks = DEFAULT_LOCKS, root = REPO_ROOT, opts = {}) {
  const entries = locks.flatMap((l) => readLockPackages(l, root));
  const licenses = auditLicenses(entries);
  const installScripts = auditInstallScripts(entries, {
    readScripts: (e) => readInstalledScripts(e, root),
    ...opts,
  });
  const sources = auditSources(entries);
  return {
    entries,
    licenses,
    installScripts,
    sources,
    report: buildReport(entries, licenses),
  };
}

export function isFailing(result, strict = false) {
  return (
    result.licenses.denied.length > 0 ||
    result.installScripts.length > 0 ||
    result.sources.length > 0 ||
    (strict && result.licenses.review.length > 0)
  );
}

export function main(argv = process.argv.slice(2), root = REPO_ROOT) {
  const locks = [];
  let out = DEFAULT_REPORT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--lock") locks.push(argv[++i]);
    else if (argv[i] === "--out") out = argv[++i];
  }
  const flags = new Set(argv);
  const result = runAudit(locks.length ? locks : DEFAULT_LOCKS, root);
  const serialized = JSON.stringify(result.report, null, 2) + "\n";
  const outPath = path.resolve(root, out);
  let stale = false;

  if (flags.has("--check")) {
    let current = "";
    try {
      current = fs.readFileSync(outPath, "utf8");
    } catch {
      // Missing report counts as stale.
    }
    stale = current !== serialized;
  } else if (!flags.has("--no-write")) {
    fs.writeFileSync(outPath, serialized);
  }

  if (flags.has("--json")) {
    console.log(
      JSON.stringify(
        {
          summary: result.report.summary,
          denied: result.licenses.denied.map((e) => e.path),
          installScripts: result.installScripts.map((f) => ({
            path: f.path,
            kind: f.kind,
          })),
          sources: result.sources.map((f) => ({ path: f.path, kind: f.kind })),
        },
        null,
        2,
      ),
    );
  } else {
    const s = result.report.summary;
    console.log(
      `audit-deps: ${s.total} packages — ${s.approved} approved, ${s.review} review, ${s.excepted} excepted, ${s.denied} denied`,
    );
    for (const e of result.licenses.denied)
      console.error(`DENIED: ${e.path}@${e.version} license=${e.license}`);
    for (const f of result.installScripts)
      console.error(
        `INSTALL-SCRIPT: ${f.path}@${f.version} ${f.kind}${f.hits ? ` (${f.hits.join(", ")})` : ""}`,
      );
    for (const f of result.sources)
      console.error(
        `SOURCE: ${f.path}@${f.version} ${f.kind}${f.detail ? ` (${f.detail})` : ""}`,
      );
    if (stale)
      console.error(
        `STALE: ${out} is out of date — run \`npm run security:audit-deps\` and commit it`,
      );
  }

  const failed = isFailing(result, flags.has("--strict")) || stale;
  if (!flags.has("--json"))
    console.log(failed ? "audit-deps: FAIL" : "audit-deps: OK");
  return failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
