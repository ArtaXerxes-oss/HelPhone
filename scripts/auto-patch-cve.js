#!/usr/bin/env node
// #599 — Automated CVE patch bot.
//
// 1. Parse GitHub Security Advisories affecting the installed npm tree:
//      --source npm-audit  (default) `npm audit --json` (GitHub Advisory DB)
//      --source github     GitHub REST /advisories?affects=... (GITHUB_TOKEN
//                          recommended; gives first_patched_version directly)
//      --advisories <file> offline fixture: GitHub REST array or npm audit JSON
// 2. Plan the MINIMUM patched version for every vulnerable name@version in
//    package-lock.json: the lowest published, non-prerelease, non-deprecated
//    version above the installed one that no known advisory matches
//    (same major preferred; a major bump is flagged as breaking).
//      direct deps (package.json / server/package.json) -> bump the range
//      transitive deps                                -> root `overrides`:
//        `"name": "^patched"` floor when every installed copy shares the
//        patched major, else `"name@<vulnerable>": "patched"` (other majors
//        untouched)
// 3. --apply: write manifests, `npm install`, re-audit, then run the full
//    regression suite (`--verify <cmd>`, repeatable; default `npm test`).
//    Any failure restores package.json / server/package.json / lockfile.
//    Packages in the `crypto-core` tier of crypto-pins.json (Barretenberg/Noir)
//    are never applied: they are reported as needing manual review (#779).
// 4. --open-pr: commit on a `security/cve-patch-*` branch, push and open a PR
//    (via `gh`) listing every advisory, the version moves and verification.
//
// Usage:
//   node scripts/auto-patch-cve.js [--source npm-audit|github] [--advisories <f>]
//        [--min-severity low|moderate|high|critical] [--fail-on <severity>]
//        [--apply] [--verify "<cmd>"]... [--open-pr] [--base main]
//        [--allow-major] [--offline] [--json]
// Without --apply it only prints the plan (dry run).
//
// Zero runtime dependencies (node built-ins + npm/git/gh CLIs).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { holdCryptoCore, loadPolicy } from "./check-crypto-pins.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const MANIFESTS = ["package.json", "server/package.json"];
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];
const SEVERITIES = ["low", "moderate", "high", "critical"];

export const severityRank = (s) => {
  const norm = String(s || "").toLowerCase() === "medium" ? "moderate" : String(s || "").toLowerCase();
  return SEVERITIES.indexOf(norm);
};

// ── Minimal semver (enough for advisory ranges) ──────────────────────────

export function parseVersion(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +(m[2] || 0), patch: +(m[3] || 0), pre: m[4] || "" };
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return String(a).localeCompare(String(b));
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // release > prerelease
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

function expandComparator(tok) {
  const m = /^(<=|>=|<|>|=|\^|~)?\s*v?(.+)$/.exec(tok);
  const [, op = "=", ver] = m;
  const p = parseVersion(ver);
  if (!p) return [];
  if (op === "^") {
    const upper = p.major > 0 ? `${p.major + 1}.0.0` : p.minor > 0 ? `0.${p.minor + 1}.0` : `0.0.${p.patch + 1}`;
    return [[">=", ver], ["<", `${upper}-0`]];
  }
  if (op === "~") return [[">=", ver], ["<", `${p.major}.${p.minor + 1}.0-0`]];
  return [[op, ver]];
}

/** Parse an advisory range (GitHub ">= 1.0.0, < 1.2.3" or npm ">=1.0.0 <1.2.3",
 *  "1.0.0 - 1.2.2", "a || b", "*") into OR-ed sets of [op, version]. */
export function parseRange(range) {
  const r = String(range ?? "*").trim();
  return r.split("||").map((set) => {
    const s = set.replace(/,/g, " ").trim();
    if (!s || s === "*" || s.toLowerCase() === "x") return [];
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(s);
    if (hyphen) return [[">=", hyphen[1]], ["<=", hyphen[2]]];
    const toks = s.replace(/(<=|>=|<|>|=|\^|~)\s+/g, "$1").split(/\s+/);
    return toks.flatMap(expandComparator);
  });
}

export function satisfies(version, range) {
  return parseRange(range).some((set) =>
    set.every(([op, v]) => {
      const c = compareVersions(version, v);
      return op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : op === ">=" ? c >= 0 : c === 0;
    }),
  );
}

/** Exclusive upper bound (`< X`) of the range set that matches `version`. */
export function upperBound(version, range) {
  for (const set of parseRange(range)) {
    if (!satisfies(version, set.map(([op, v]) => `${op}${v}`).join(" "))) continue;
    const lt = set.find(([op]) => op === "<");
    if (lt) return lt[1];
  }
  return null;
}

// ── Advisory normalization ───────────────────────────────────────────────

/** GitHub REST `/advisories` (global advisories) response -> advisories. */
export function normalizeGithubAdvisories(list) {
  const out = [];
  for (const adv of list || []) {
    for (const v of adv.vulnerabilities || []) {
      if (v.package?.ecosystem && v.package.ecosystem.toLowerCase() !== "npm") continue;
      const patched = typeof v.first_patched_version === "string"
        ? v.first_patched_version
        : v.first_patched_version?.identifier;
      out.push({
        id: adv.ghsa_id,
        cve: adv.cve_id || null,
        package: v.package?.name,
        severity: (adv.severity || "unknown").toLowerCase(),
        range: v.vulnerable_version_range,
        firstPatched: patched || null,
        url: adv.html_url || `https://github.com/advisories/${adv.ghsa_id}`,
        title: adv.summary || "",
      });
    }
  }
  return dedupeAdvisories(out);
}

/** `npm audit --json` (v7+) -> advisories. Only concrete `via` objects carry
 *  advisory data; string `via` entries just point at another package. */
export function normalizeNpmAudit(report) {
  const out = [];
  for (const vuln of Object.values(report?.vulnerabilities || {})) {
    for (const via of vuln.via || []) {
      if (typeof via !== "object") continue;
      const ghsa = /GHSA-[\w-]+/.exec(via.url || "")?.[0];
      out.push({
        id: ghsa || String(via.source),
        cve: null,
        package: via.name,
        severity: (via.severity || "unknown").toLowerCase(),
        range: via.range,
        firstPatched: null,
        url: via.url,
        title: via.title || "",
      });
    }
  }
  return dedupeAdvisories(out);
}

function dedupeAdvisories(list) {
  const seen = new Map();
  for (const a of list) if (a.package && a.range) seen.set(`${a.id}:${a.package}:${a.range}`, a);
  return [...seen.values()];
}

// ── Planning ─────────────────────────────────────────────────────────────

/** name -> manifest files declaring it directly. */
export function directDeps(manifests) {
  const map = new Map();
  for (const [file, pkg] of Object.entries(manifests)) {
    for (const field of DEP_FIELDS) {
      for (const name of Object.keys(pkg?.[field] || {})) {
        if (!map.has(name)) map.set(name, []);
        map.get(name).push(file);
      }
    }
  }
  return map;
}

/** Installed name@version occurrences from package-lock.json. */
export function collectInstalled(lock) {
  const out = [];
  for (const [p, meta] of Object.entries(lock.packages || {})) {
    const idx = p.lastIndexOf("node_modules/");
    if (idx === -1 || meta.link || !meta.version) continue;
    const name = p.slice(idx + "node_modules/".length);
    // Hoisted into a top-level node_modules (root or workspace) => may be direct.
    const hoisted = idx === 0 || !p.slice(0, idx).includes("node_modules/");
    out.push({ name, version: meta.version, path: p, hoisted });
  }
  return out;
}

/** Pick the minimum safe version above `version`. */
export function pickPatchedVersion(version, matching, allForPkg, published) {
  const isVulnerable = (v) => allForPkg.some((a) => satisfies(v, a.range));
  if (published && published.length) {
    const ok = published
      .filter((v) => {
        const p = parseVersion(v);
        return p && !p.pre && compareVersions(v, version) > 0 && !isVulnerable(v);
      })
      .sort(compareVersions);
    const major = parseVersion(version)?.major;
    const sameMajor = ok.find((v) => parseVersion(v).major === major);
    const to = sameMajor || ok[0];
    return to ? { to, breaking: !sameMajor } : null;
  }
  const bounds = matching.map((a) => a.firstPatched || upperBound(version, a.range));
  if (bounds.some((b) => !b)) return null; // e.g. "<= X": needs the published list
  const to = bounds.sort(compareVersions).at(-1);
  if (isVulnerable(to)) return null;
  return { to, breaking: parseVersion(to).major !== parseVersion(version).major };
}

/**
 * Build the patch plan.
 * @param versionsOf async (name) => string[] | null  published versions
 */
export async function planPatches({ lock, manifests, advisories, versionsOf = async () => null, allowMajor = false }) {
  const direct = directDeps(manifests);
  const byPkg = new Map();
  for (const a of advisories) {
    if (!byPkg.has(a.package)) byPkg.set(a.package, []);
    byPkg.get(a.package).push(a);
  }

  // Majors of every installed copy, to decide whether a name-level override
  // floor is safe (it would otherwise drag other majors along).
  const majors = new Map();
  for (const occ of collectInstalled(lock)) {
    if (!majors.has(occ.name)) majors.set(occ.name, new Set());
    majors.get(occ.name).add(parseVersion(occ.version)?.major);
  }

  const seen = new Set();
  const patches = [];
  const unresolved = [];
  for (const occ of collectInstalled(lock)) {
    const allForPkg = byPkg.get(occ.name);
    if (!allForPkg) continue;
    const matching = allForPkg.filter((a) => satisfies(occ.version, a.range));
    if (!matching.length) continue;
    const isDirect = occ.hoisted && direct.has(occ.name);
    const key = `${occ.name}@${occ.version}:${isDirect}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const sortedAdvs = [...new Map(matching.map((a) => [a.id, a])).values()].sort((a, b) => a.id.localeCompare(b.id));
    const base = {
      name: occ.name,
      from: occ.version,
      advisories: sortedAdvs.map((a) => a.id),
      severity: matching.map((a) => a.severity).sort((x, y) => severityRank(y) - severityRank(x))[0],
      urls: sortedAdvs.map((a) => a.url || ""),
    };
    const needsRegistry = matching.some((a) => !a.firstPatched && !upperBound(occ.version, a.range));
    const published = needsRegistry || !matching.every((a) => a.firstPatched)
      ? await versionsOf(occ.name)
      : null;
    const pick = pickPatchedVersion(occ.version, matching, allForPkg, published);
    if (!pick) {
      unresolved.push({ ...base, reason: "no published non-vulnerable version found" });
      continue;
    }
    if (pick.breaking && !allowMajor) {
      unresolved.push({ ...base, to: pick.to, reason: `fix requires a major bump to ${pick.to} (re-run with --allow-major)` });
      continue;
    }
    patches.push({
      ...base,
      to: pick.to,
      breaking: pick.breaking,
      strategy: isDirect ? "manifest" : "override",
      manifests: isDirect ? direct.get(occ.name) : ["package.json"],
      singleMajor: [...majors.get(occ.name)].every((m) => m === parseVersion(pick.to).major),
    });
  }
  const order = (p) => [-severityRank(p.severity), p.name, p.from];
  const cmp = (a, b) => {
    const [x, y] = [order(a), order(b)];
    return x[0] - y[0] || x[1].localeCompare(y[1]) || compareVersions(x[2], y[2]);
  };
  return { patches: patches.sort(cmp), unresolved: unresolved.sort(cmp) };
}

/** Apply a plan to manifest objects (returns new objects + skipped patches). */
export function applyPlan(manifests, plan) {
  const next = structuredClone(manifests);
  const applied = [];
  const skipped = [];
  for (const patch of plan.patches) {
    if (patch.strategy === "manifest") {
      let ok = false;
      for (const file of patch.manifests) {
        for (const field of DEP_FIELDS) {
          const spec = next[file]?.[field]?.[patch.name];
          if (spec === undefined) continue;
          const bare = spec.replace(/^[\^~]/, "");
          if (!parseVersion(bare) && !/^[<>=\s\d.x*|^~-]+$/.test(spec)) continue; // git/file/workspace specs
          const prefix = /^[\^~]/.exec(spec)?.[0] ?? (parseVersion(spec) ? "" : "^");
          next[file][field][patch.name] = `${prefix}${patch.to}`;
          ok = true;
        }
      }
      (ok ? applied : skipped).push(ok ? patch : { ...patch, reason: "non-semver dependency spec" });
    } else {
      const root = next["package.json"];
      root.overrides ||= {};
      const existing = root.overrides[patch.name];
      const ours = typeof existing === "string" && existing.startsWith("^") && parseVersion(existing.slice(1));
      if (existing !== undefined && !ours) {
        skipped.push({ ...patch, reason: `existing override for ${patch.name}` });
        continue;
      }
      if (patch.singleMajor) {
        // Name-level floor: npm reliably re-resolves every copy below it.
        // (A version-keyed override leaves hoisted copies that still satisfy
        // their dependents' ranges untouched.) Keep the highest floor when
        // several vulnerable versions of one package are patched.
        const floor = ours && compareVersions(existing.slice(1), patch.to) > 0 ? existing : `^${patch.to}`;
        root.overrides[patch.name] = floor;
      } else {
        root.overrides[`${patch.name}@${patch.from}`] = patch.to;
      }
      applied.push(patch);
    }
  }
  return { manifests: next, applied, skipped };
}

/** Lockfile occurrences of patched packages that still match an advisory. */
export function residualVulnerable(lock, advisories, applied) {
  const names = new Set(applied.map((p) => p.name));
  return collectInstalled(lock).filter(
    (o) => names.has(o.name) && advisories.some((a) => a.package === o.name && satisfies(o.version, a.range)),
  );
}

export function renderPrBody({ applied, skipped = [], unresolved = [], verification = [] }) {
  const row = (p) =>
    `| \`${p.name}\` | ${p.from} → **${p.to}**${p.breaking ? " ⚠️ major" : ""} | ${p.severity} | ${p.strategy} | ${p.advisories
      .map((id, i) => (p.urls[i] ? `[${id}](${p.urls[i]})` : id))
      .join(", ")} |`;
  const lines = [
    "## Automated security patch (CVE patch bot, #599)",
    "",
    `Patches **${applied.length}** vulnerable dependency version(s) to the minimum non-vulnerable release.`,
    "",
    "| Package | Version | Severity | Strategy | Advisories |",
    "| --- | --- | --- | --- | --- |",
    ...applied.map(row),
    "",
    "### Regression verification",
    "",
    ...(verification.length
      ? verification.map((v) => `- ${v.ok ? "✅" : "❌"} \`${v.cmd}\``)
      : ["- not run"]),
  ];
  if (skipped.length || unresolved.length) {
    lines.push("", "### Needs manual follow-up", "");
    for (const p of [...skipped, ...unresolved])
      lines.push(`- \`${p.name}@${p.from}\` (${p.advisories.join(", ")}): ${p.reason}`);
  }
  lines.push(
    "",
    "Strategy `manifest` bumps a direct dependency range; `override` raises a transitive dependency via root `overrides` (a `^patched` floor when every installed copy shares that major, otherwise keyed by the exact vulnerable version). See `docs/security-runbook.md`.",
  );
  return lines.join("\n") + "\n";
}

// ── I/O ──────────────────────────────────────────────────────────────────

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));

function npmAudit() {
  // npm audit exits 1 when vulnerabilities exist; the JSON is still on stdout.
  const res = spawnSync("npm", ["audit", "--json", "--package-lock-only"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!res.stdout) throw new Error(`npm audit produced no output: ${res.stderr?.slice(0, 300)}`);
  const report = JSON.parse(res.stdout);
  if (report.error) throw new Error(`npm audit: ${report.error.summary || report.error.code}`);
  return normalizeNpmAudit(report);
}

async function githubAdvisories(lock) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const pkgs = [...new Set(collectInstalled(lock).map((o) => `${o.name}@${o.version}`))];
  const out = [];
  for (let i = 0; i < pkgs.length; i += 100) {
    const affects = pkgs.slice(i, i + 100).join(",");
    let url = `https://api.github.com/advisories?ecosystem=npm&per_page=100&affects=${encodeURIComponent(affects)}`;
    while (url) {
      const res = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`GitHub advisories API ${res.status}`);
      out.push(...(await res.json()));
      url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") || "")?.[1];
    }
  }
  return normalizeGithubAdvisories(out);
}

function loadAdvisoryFile(file) {
  const data = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  return Array.isArray(data) ? normalizeGithubAdvisories(data) : normalizeNpmAudit(data);
}

function registryVersions(offline) {
  const cache = new Map();
  return async (name) => {
    if (offline) return null;
    if (!cache.has(name)) {
      cache.set(name, (async () => {
        try {
          const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, {
            headers: { Accept: "application/vnd.npm.install-v1+json" },
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) return null;
          const doc = await res.json();
          return Object.entries(doc.versions || {}).filter(([, m]) => !m.deprecated).map(([v]) => v);
        } catch {
          return null;
        }
      })());
    }
    return cache.get(name);
  };
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${[cmd, ...args].join(" ")}`);
  const res = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit", ...opts });
  return res.status === 0;
}

function printPlan(plan) {
  console.log(`cve-patch: ${plan.patches.length} patch(es), ${plan.unresolved.length} unresolved`);
  for (const p of plan.patches)
    console.log(
      `  [${p.severity}] ${p.name} ${p.from} -> ${p.to}${p.breaking ? " (MAJOR)" : ""} via ${p.strategy} (${p.advisories.join(", ")})`,
    );
  for (const p of plan.unresolved)
    console.log(`  [${p.severity}] ${p.name}@${p.from}: UNRESOLVED — ${p.reason} (${p.advisories.join(", ")})`);
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : def;
  };
  const getAll = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  const source = getArg("--source", "npm-audit");
  const minSeverity = getArg("--min-severity", "low");
  const failOn = getArg("--fail-on");
  const openPr = args.includes("--open-pr");
  const apply = args.includes("--apply") || openPr;
  const offline = args.includes("--offline");
  const verifyCmds = getAll("--verify");
  if (!verifyCmds.length) verifyCmds.push("npm test");

  const lock = readJson("package-lock.json");
  const manifests = Object.fromEntries(
    MANIFESTS.filter((f) => fs.existsSync(path.join(REPO_ROOT, f))).map((f) => [f, readJson(f)]),
  );

  let advisories;
  try {
    const file = getArg("--advisories");
    advisories = file ? loadAdvisoryFile(file) : source === "github" ? await githubAdvisories(lock) : npmAudit();
  } catch (e) {
    console.error(`cve-patch: advisory lookup failed: ${e.message}`);
    process.exit(2);
  }
  advisories = advisories.filter((a) => severityRank(a.severity) >= severityRank(minSeverity));

  // #779: crypto-core pins (crypto-pins.json) are never auto-applied.
  const plan = holdCryptoCore(
    await planPatches({
      lock,
      manifests,
      advisories,
      versionsOf: registryVersions(offline),
      allowMajor: args.includes("--allow-major"),
    }),
    loadPolicy(),
  );
  if (args.includes("--json")) console.log(JSON.stringify(plan, null, 2));
  else printPlan(plan);

  const failing = failOn
    ? [...plan.patches, ...plan.unresolved].filter((p) => severityRank(p.severity) >= severityRank(failOn))
    : [];

  if (!apply || plan.patches.length === 0) {
    if (failing.length) {
      console.error(`cve-patch: FAIL — ${failing.length} vulnerable package(s) at or above '${failOn}'`);
      process.exit(1);
    }
    return;
  }

  // ── Apply + regression verification ──
  const tracked = [...Object.keys(manifests), "package-lock.json"];
  const backup = Object.fromEntries(tracked.map((f) => [f, fs.readFileSync(path.join(REPO_ROOT, f), "utf8")]));
  const restore = () => {
    for (const [f, body] of Object.entries(backup)) fs.writeFileSync(path.join(REPO_ROOT, f), body);
    console.error("cve-patch: restored package.json / server/package.json / package-lock.json");
  };

  const result = applyPlan(manifests, plan);
  for (const [f, pkg] of Object.entries(result.manifests))
    fs.writeFileSync(path.join(REPO_ROOT, f), JSON.stringify(pkg, null, 2) + "\n");

  if (!run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"])) {
    restore();
    process.exit(1);
  }

  const verification = [];
  const residual = residualVulnerable(readJson("package-lock.json"), advisories, result.applied);
  for (const r of residual) console.warn(`cve-patch: WARN ${r.name}@${r.version} still vulnerable in lockfile (${r.path})`);
  verification.push({ cmd: "package-lock.json re-resolved to patched versions", ok: residual.length === 0 });
  if (source === "npm-audit" && !getArg("--advisories")) {
    const remaining = new Set(npmAudit().map((a) => `${a.package}:${a.id}`));
    const still = result.applied.filter((p) => p.advisories.some((id) => remaining.has(`${p.name}:${id}`)));
    for (const p of still) console.warn(`cve-patch: WARN ${p.name} still reported after patch (another copy?)`);
    verification.push({ cmd: "npm audit (patched advisories cleared)", ok: still.length === 0 });
  }
  for (const cmd of verifyCmds) {
    const ok = run("sh", ["-c", cmd]);
    verification.push({ cmd, ok });
    if (!ok) {
      console.error(`cve-patch: regression verification failed: ${cmd}`);
      restore();
      run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
      process.exit(1);
    }
  }

  const body = renderPrBody({ ...result, unresolved: plan.unresolved, verification });
  const bodyFile = path.join(REPO_ROOT, ".cve-patch-pr.md");
  fs.writeFileSync(bodyFile, body);
  console.log(`cve-patch: applied ${result.applied.length} patch(es); PR body -> .cve-patch-pr.md`);

  if (openPr) {
    const base = getArg("--base", "main");
    const stamp = new Date().toISOString().slice(0, 10);
    const branch = `security/cve-patch-${stamp}-${process.env.GITHUB_RUN_ID || process.pid}`;
    const title = `fix(security): patch ${result.applied.length} vulnerable dependenc${result.applied.length === 1 ? "y" : "ies"}`;
    const ok =
      run("git", ["checkout", "-b", branch]) &&
      run("git", ["add", ...tracked]) &&
      run("git", ["commit", "-m", title, "-m", "Automated by scripts/auto-patch-cve.js (#599)."]) &&
      run("git", ["push", "-u", "origin", branch]) &&
      run("gh", ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body-file", bodyFile]);
    fs.rmSync(bodyFile, { force: true });
    if (!ok) {
      console.error("cve-patch: failed to open the security PR");
      process.exit(1);
    }
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`cve-patch: ${e.stack || e.message}`);
    process.exit(2);
  });
}
