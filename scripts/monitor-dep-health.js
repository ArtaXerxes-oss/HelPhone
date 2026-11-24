#!/usr/bin/env node
// #591 / #949 — Open-source dependency health & sustainability monitor
// with committed local metadata cache & offline fallback.
//
// Usage:
//   node scripts/monitor-dep-health.js [--json] [--write <path>] [--offline] [--cache <path>] [--update-cache] [--fail-on-known-bad]
//
// Zero runtime dependencies (node built-ins only). Registry failures fall back
// to the committed metadata cache and mark the report explicitly as degraded.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const DEFAULT_CACHE_PATH = path.join(
  REPO_ROOT,
  "config",
  "dep-health-cache.json",
);
export const ABANDONED_MONTHS = 12;

export function monthsSince(dateStr, now = new Date()) {
  if (!dateStr) return null;
  const then = new Date(dateStr);
  if (Number.isNaN(then.getTime())) return null;
  const ms = now.getTime() - then.getTime();
  if (ms < 0) return 0;
  return ms / (1000 * 60 * 60 * 24 * 30.4375);
}

export function classifyDep(
  { lastPublish, openIssues } = {},
  now = new Date(),
) {
  const age = monthsSince(lastPublish, now);
  if (age === null) return "unknown";
  if (age > ABANDONED_MONTHS) return "abandoned";
  if (typeof openIssues === "number" && openIssues > 500) return "at-risk";
  if (age > 6) return "stale";
  return "healthy";
}

// 0–100 index over known dependencies: healthy=1, stale=0.6, at-risk=0.3, abandoned=0.
// Unknown dependencies are excluded so offline/unreachable registries do not report
// a falsely low score (50/100); returns null when zero dependencies are known.
export function healthIndex(results) {
  const known = results.filter((r) => r.status !== "unknown");
  if (known.length === 0) return null;
  const weights = {
    healthy: 1,
    stale: 0.6,
    "at-risk": 0.3,
    abandoned: 0,
  };
  const sum = known.reduce((s, r) => s + (weights[r.status] ?? 0), 0);
  return Math.round((sum / known.length) * 100);
}

export function collectDirectDeps(root = REPO_ROOT) {
  const out = new Map();
  for (const file of ["package.json", "server/package.json"]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
      for (const section of ["dependencies", "devDependencies"]) {
        for (const [name, range] of Object.entries(pkg[section] || {})) {
          if (!out.has(name)) out.set(name, { name, range, from: file });
        }
      }
    } catch {
      // Skip unreadable manifests.
    }
  }
  return [...out.values()];
}

export function loadMetadataCache(cachePath = DEFAULT_CACHE_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return {
      generatedAt: raw.generatedAt || null,
      packages: raw.packages && typeof raw.packages === "object" ? raw.packages : {},
    };
  } catch {
    return { generatedAt: null, packages: {} };
  }
}

export function saveMetadataCache(
  cachePath = DEFAULT_CACHE_PATH,
  packages = {},
  now = new Date(),
) {
  const sorted = {};
  for (const name of Object.keys(packages).sort()) {
    sorted[name] = packages[name];
  }
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(
    cachePath,
    `${JSON.stringify({ schemaVersion: 1, generatedAt: now.toISOString(), packages: sorted }, null, 2)}\n`,
  );
}

export async function fetchNpmMeta(
  name,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(
      `https://registry.npmjs.org/${encodeURIComponent(name)}`,
      { signal: controller.signal },
    );
    if (!res.ok) return { name, ok: false, reason: `http-${res.status}` };
    const data = await res.json();
    const times = data.time || {};
    const lastPublish =
      times.modified || times[data["dist-tags"]?.latest] || null;
    return {
      name,
      ok: true,
      lastPublish,
      version: data["dist-tags"]?.latest || null,
    };
  } catch (err) {
    return { name, ok: false, reason: String(err?.message || err) };
  } finally {
    clearTimeout(t);
  }
}

export async function scoreDependencies({
  deps,
  cache = { packages: {} },
  offline = false,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const packages = cache.packages || {};
  const results = [];
  let registryFailures = 0;

  for (const d of deps) {
    const cached = packages[d.name] || null;

    if (offline) {
      const lastPublish = cached?.lastPublish || null;
      const status = classifyDep(
        { lastPublish, openIssues: cached?.openIssues },
        now,
      );
      results.push({
        ...d,
        lastPublish,
        status,
        source: cached ? "cache" : "unknown",
      });
      continue;
    }

    const meta = await fetchNpmMeta(d.name, fetchImpl);
    if (meta.ok) {
      const status = classifyDep({ lastPublish: meta.lastPublish }, now);
      results.push({
        ...d,
        lastPublish: meta.lastPublish,
        version: meta.version,
        status,
        source: "registry",
      });
    } else {
      registryFailures += 1;
      const lastPublish = cached?.lastPublish || null;
      const status = classifyDep(
        { lastPublish, openIssues: cached?.openIssues },
        now,
      );
      results.push({
        ...d,
        lastPublish,
        status,
        source: cached ? "cache-fallback" : "unknown",
      });
    }
  }

  const degraded = offline || registryFailures > 0;
  const degradedReason = offline
    ? "offline-mode"
    : registryFailures > 0
      ? "registry-unreachable"
      : null;
  const index = healthIndex(results);

  return {
    results,
    index,
    degraded,
    degradedReason,
    registryFailures,
  };
}

export function shouldFailCi({ results, index }) {
  const hasAbandoned = results.some((r) => r.status === "abandoned");
  const lowKnownIndex = index !== null && index < 50;
  return hasAbandoned || lowKnownIndex;
}

export function renderReport(
  results,
  index,
  {
    degraded = false,
    degradedReason = null,
    cachePath = "config/dep-health-cache.json",
  } = {},
) {
  const rows = results
    .map(
      (r) =>
        `| ${r.name} | ${r.range} | ${r.lastPublish || "unknown"} | ${r.status} | ${r.source || "unknown"} |`,
    )
    .join("\n");
  const abandoned = results.filter((r) => r.status === "abandoned");
  const indexLabel =
    index === null ? "N/A (degraded — no known metadata)" : `${index}/100`;
  const degradedBanner = degraded
    ? `> **DEGRADED (${degradedReason || "offline"})**: Live npm registry was ${degradedReason === "offline-mode" ? "skipped (--offline)" : "unreachable"}; scored from committed metadata cache (\`${cachePath}\`).\n\n`
    : "";

  return (
    `# Sustainability Report\n\n` +
    `> Auto-generated by \`scripts/monitor-dep-health.js\` (#591, #949). Do not edit by hand.\n\n` +
    degradedBanner +
    `## Health index: ${indexLabel}\n\n` +
    `- Degraded: ${degraded ? `yes (${degradedReason})` : "no"}\n` +
    `- Dependencies scored: ${results.length}\n` +
    `- Healthy: ${results.filter((r) => r.status === "healthy").length}\n` +
    `- Stale (>6mo): ${results.filter((r) => r.status === "stale").length}\n` +
    `- At-risk: ${results.filter((r) => r.status === "at-risk").length}\n` +
    `- Abandoned (>12mo): ${abandoned.length}\n` +
    `- Unknown (no registry or cache metadata): ${results.filter((r) => r.status === "unknown").length}\n\n` +
    `## Abandoned packages\n\n` +
    (abandoned.length
      ? abandoned
          .map(
            (r) =>
              `- ${r.name} (${r.range}, last publish ${r.lastPublish || "unknown"})`,
          )
          .join("\n") + "\n"
      : "None.\n") +
    `\n## All dependencies\n\n| Package | Range | Last publish | Status | Source |\n| --- | --- | --- | --- | --- |\n${rows}\n`
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const offline = args.includes("--offline");
  const updateCache = args.includes("--update-cache");
  const failOnKnownBad = args.includes("--fail-on-known-bad");
  const cacheIdx = args.indexOf("--cache");
  const cachePath =
    cacheIdx !== -1
      ? path.resolve(REPO_ROOT, args[cacheIdx + 1])
      : DEFAULT_CACHE_PATH;
  const writeIdx = args.indexOf("--write");
  const writePath =
    writeIdx !== -1 ? args[writeIdx + 1] : "docs/sustainability-report.md";

  const deps = collectDirectDeps();
  const cache = loadMetadataCache(cachePath);
  const scored = await scoreDependencies({ deps, cache, offline });

  if (updateCache && !offline) {
    const nextPackages = { ...cache.packages };
    for (const r of scored.results) {
      if (r.source === "registry" && r.lastPublish) {
        nextPackages[r.name] = {
          version: r.version || null,
          lastPublish: r.lastPublish,
        };
      }
    }
    saveMetadataCache(cachePath, nextPackages);
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          index: scored.index,
          degraded: scored.degraded,
          degradedReason: scored.degradedReason,
          results: scored.results,
        },
        null,
        2,
      ),
    );
  } else {
    const idxText = scored.index === null ? "N/A" : `${scored.index}/100`;
    console.log(
      `dep-health: ${deps.length} deps scored, index ${idxText}, degraded=${scored.degraded}${scored.degradedReason ? ` (${scored.degradedReason})` : ""}`,
    );
    for (const r of scored.results.filter((x) => x.status === "abandoned")) {
      console.log(
        `ABANDONED: ${r.name} last publish ${r.lastPublish || "unknown"}`,
      );
    }
    console.log(
      shouldFailCi(scored)
        ? "dep-health: KNOWN-BAD (abandoned or index < 50)"
        : "dep-health: OK",
    );
  }

  if (writePath) {
    fs.writeFileSync(
      path.resolve(REPO_ROOT, writePath),
      renderReport(scored.results, scored.index, {
        degraded: scored.degraded,
        degradedReason: scored.degradedReason,
        cachePath: path.relative(REPO_ROOT, cachePath),
      }),
    );
    console.log(`dep-health: report written -> ${writePath}`);
  }

  if (failOnKnownBad && shouldFailCi(scored)) {
    process.exit(1);
  }
}
