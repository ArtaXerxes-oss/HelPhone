#!/usr/bin/env node
/**
 * Unified perf-budget verdict (#795).
 *
 * Folds the three instruments into one pass/fail against perf-budget.json:
 *   bytes  — dist/assets/*.js sizes + dist/.vite/manifest.json (sunburst input)
 *   ms     — artifacts/perf-budget/client-<project>.json (throttled Playwright
 *            leg: labelled measures + long tasks) and the bytes→ms model
 *   server — /metrics scrape (helphone_link_duration_seconds, indexer lag)
 *
 * Usage:
 *   node scripts/perf-budget.mjs [--dist dist] [--client artifacts/perf-budget/client-field-moto-g4.json]
 *        [--metrics http://localhost:3001/metrics] [--out artifacts/perf-budget/verdict.json]
 *        [--inject-chunk mapbox=200] [--inject-indexer-lag 15]
 *
 * --inject-* add synthetic regressions to prove the harness goes red.
 * Exit code 1 on any breach. Missing inputs are reported as "skipped", never as passes.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]);
    return acc;
  }, []),
);

const budget = JSON.parse(readFileSync("perf-budget.json", "utf8"));
const dist = args.dist ?? "dist";
const clientPath = args.client ?? `artifacts/perf-budget/client-${budget.profile.name}.json`;
const outPath = args.out ?? "artifacts/perf-budget/verdict.json";
const injected = {};
if (args["inject-chunk"]) {
  const [name, kb] = args["inject-chunk"].split("=");
  injected[name] = Number(kb) || 0;
}
const injectedLag = Number(args["inject-indexer-lag"] ?? 0) || 0;

const checks = [];
const check = (link, owner, actual, limit, unit, note) =>
  checks.push({ link, owner, actual, limit, unit, status: actual == null ? "skipped" : actual <= limit ? "pass" : "fail", note });

const parseMs = (kb) => budget.bytesToMs.fixedMs + kb * budget.bytesToMs.msPerKb;

// ── bytes ────────────────────────────────────────────────────────────────────
const assetsDir = join(dist, "assets");
const chunks = {};
if (existsSync(assetsDir)) {
  for (const f of readdirSync(assetsDir).filter((f) => f.endsWith(".js"))) {
    const name = f.replace(/-[\w-]{8}\.js$/, "");
    chunks[name] = (chunks[name] ?? 0) + statSync(join(assetsDir, f)).size / 1024;
  }
}
for (const [name, kb] of Object.entries(injected)) chunks[name] = (chunks[name] ?? 0) + kb;

for (const [name, cap] of Object.entries(budget.chunks.caps)) {
  const kb = chunks[name] != null ? Math.round(chunks[name]) : null;
  check(`chunk:${name}`, "frontend", kb, cap, "KB", kb != null ? `≈${Math.round(parseMs(kb))}ms parse on ${budget.profile.name}` : "chunk not found in dist/assets");
}

const manifestPath = join(dist, ".vite", "manifest.json");
let initialKb = null;
const eager = new Set();
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = Object.values(manifest).find((m) => m.isEntry);
  const walk = (key) => {
    const m = manifest[key];
    if (!m || eager.has(m.file)) return;
    eager.add(m.file);
    (m.imports ?? []).forEach(walk);
  };
  if (entry) walk(Object.keys(manifest).find((k) => manifest[k] === entry));
  initialKb = Math.round([...eager].reduce((s, f) => s + (existsSync(join(dist, f)) ? statSync(join(dist, f)).size : 0), 0) / 1024);
  for (const name of budget.chunks.mustBeLazy) {
    const leaked = [...eager].some((f) => f.includes(`/${name}-`));
    checks.push({ link: `lazy:${name}`, owner: "frontend", actual: leaked ? "initial" : "lazy", limit: "lazy", unit: "", status: leaked ? "fail" : "pass" });
  }
}
check("initialBundle", "frontend", initialKb, budget.chunks.initialKb, "KB", initialKb != null ? `≈${Math.round(parseMs(initialKb))}ms parse (±${budget.bytesToMs.errorBoundPct}%)` : "no manifest; run npm run build");
if (initialKb != null) check("bundleParse(model)", budget.links.bundleParse.owner, Math.round(parseMs(initialKb)), budget.links.bundleParse.p75Ms, "ms", "bytes→ms model estimate");

// ── client ms ────────────────────────────────────────────────────────────────
if (existsSync(clientPath)) {
  const c = JSON.parse(readFileSync(clientPath, "utf8"));
  check("tapToConfirm(proxy: help ready)", budget.endToEnd.tapToConfirm.owner, c.readyMs, budget.endToEnd.tapToConfirm.p75Ms, "ms");
  const wasm = c.measures.filter((m) => m.name === "wasm.init").reduce((a, m) => Math.max(a, m.duration), 0);
  check("wasmInitLongTask", budget.links.wasmInitLongTask.owner, c.measures.some((m) => m.name === "wasm.init") ? Math.round(wasm) : null, budget.links.wasmInitLongTask.maxMs, "ms");
  const flush = c.measures.filter((m) => m.name === "worker.flush").map((m) => m.duration);
  check("workerFlush", budget.links.workerFlush.owner, flush.length ? Math.round(Math.max(...flush)) : null, budget.links.workerFlush.p75Ms, "ms");
  const scripting = c.longTasks.reduce((s, t) => s + t.duration, 0);
  const telemetry = c.measures.filter((m) => /^(telemetry\.|worker\.flush|parser\.decode)/.test(m.name)).reduce((s, m) => s + m.duration, 0);
  check("telemetrySelfOverhead", budget.links.telemetrySelfOverhead.owner, scripting ? +(telemetry / scripting).toFixed(3) : null, budget.links.telemetrySelfOverhead.maxShareOfScripting, "share", "labelled telemetry ms / long-task ms");
} else {
  checks.push({ link: "client", owner: "frontend", status: "skipped", note: `${clientPath} missing; run npx playwright test --project=${budget.profile.name} --grep @perf` });
}

// ── server ───────────────────────────────────────────────────────────────────
function histP(text, name, labelMatch, q) {
  const rows = text.split("\n").filter((l) => l.startsWith(`${name}_bucket{`) && l.includes(labelMatch));
  const buckets = rows.map((l) => ({ le: l.match(/le="([^"]+)"/)[1], n: Number(l.split(" ").pop()) }));
  const total = buckets.find((b) => b.le === "+Inf")?.n ?? 0;
  if (!total) return null;
  const hit = buckets.find((b) => b.le !== "+Inf" && b.n >= total * q);
  return hit ? Number(hit.le) : Infinity;
}

if (args.metrics) {
  try {
    const text = await (await fetch(args.metrics)).text();
    const lag = histP(text, "helphone_link_duration_seconds", 'link="indexer.lag"', 0.95);
    check("indexerLag", budget.links.indexerLag.owner, lag == null && !injectedLag ? null : (lag ?? 0) + injectedLag, budget.links.indexerLag.p95Seconds, "s");
    const ws = histP(text, "helphone_link_duration_seconds", 'link="ws.queue"', 0.75);
    check("wsRoundTrip(server part)", budget.links.wsRoundTrip.owner, ws == null ? null : ws * 1000, budget.links.wsRoundTrip.p75Ms, "ms");
  } catch (err) {
    checks.push({ link: "server", owner: "backend", status: "skipped", note: `scrape failed: ${err.message}` });
  }
} else if (injectedLag) {
  check("indexerLag", budget.links.indexerLag.owner, injectedLag, budget.links.indexerLag.p95Seconds, "s", "injected only (no --metrics)");
}

const failed = checks.filter((c) => c.status === "fail");
const verdict = {
  budgetVersion: budget.version,
  profile: budget.profile.name,
  generatedAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? null,
  injected: { chunks: injected, indexerLagSeconds: injectedLag },
  result: failed.length ? "fail" : "pass",
  blame: failed.map((c) => `${c.link} (${c.owner}): ${c.actual}${c.unit} > ${c.limit}${c.unit}`),
  checks,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(verdict, null, 2));
for (const c of checks) console.log(`${c.status.padEnd(7)} ${c.link.padEnd(34)} ${c.actual ?? "-"}${c.unit ?? ""} / ${c.limit ?? "-"}${c.unit ?? ""}${c.note ? `  — ${c.note}` : ""}`);
console.log(`\nperf:budget ${verdict.result.toUpperCase()} → ${outPath}`);
process.exit(failed.length ? 1 : 0);
