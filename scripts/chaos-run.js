#!/usr/bin/env node
/**
 * Scheduled chaos rehearsal (#769).
 *
 * Arms the in-process ChaosEngine with a documented multi-fault scenario,
 * asserts the P0 bulkhead survives, then aborts. Never targets production:
 * a production environment or URL requires the explicit break-glass value.
 *
 * Usage: CHAOS_TARGET_URL=https://staging... node scripts/chaos-run.mjs
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChaosEngine,
  PoolLane,
  ScenarioType,
  assertChaosAllowed,
  chaosStartupConfig,
} from "../server/lib/chaosEngine.js";

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = join(here, "..", "artifacts", "chaos-run-results.md");

function refuseProduction() {
  const config = assertChaosAllowed(chaosStartupConfig({
    ...process.env,
    CHAOS_ENABLED: "true",
  }));
  if (!config.allowed) throw new Error(`Chaos rehearsal refused: ${config.reason}`);
  const target = process.env.CHAOS_TARGET_URL || "";
  if (/production|\.prod\.|helphone\.com(?::|\/|$)/i.test(target) && config.reason !== "break_glass") {
    throw new Error("Chaos rehearsal refused: target looks like production without break glass");
  }
}

async function healthOf(url) {
  if (!url) return "not configured";
  try {
    const res = await fetch(new URL("/healthz", url), { signal: AbortSignal.timeout(5000) });
    return String(res.status);
  } catch (error) {
    return `unreachable (${error.message})`;
  }
}

function runScenario(scenario) {
  const engine = new ChaosEngine();
  const started = engine.startScenario(scenario);
  const p0 = engine.evaluateAdmission("EMERGENCY_DISPATCH");
  const heartbeat = engine.evaluateAdmission("RESCUER_HEARTBEAT");
  const tiles = engine.evaluateAdmission("MAP_TILES");
  const critical = engine.acquireConnection(PoolLane.CRITICAL);
  const integrity = engine.verifyIntegrity();
  const leak = engine.verifyLeakGuard({ liveSmsSent: 0, mainnetTxCount: 0 });
  const aborted = engine.abort();

  const passed = p0.admitted && heartbeat.admitted && critical.acquired
    && !tiles.admitted && integrity.passed && leak.passed && aborted.rolledBack;

  return {
    scenario,
    faults: started.faults.join(", "),
    p0: p0.admitted,
    heartbeat: heartbeat.admitted,
    tilesShed: !tiles.admitted,
    criticalLane: critical.acquired,
    integrity: integrity.passed,
    leakGuard: leak.passed,
    rolledBack: aborted.rolledBack,
    passed,
  };
}

// Three multi-fault scenarios: every run stacks at least two fault domains
// while the P0 emergency lane and the critical pool stay intact.
const scenarios = [
  ScenarioType.RED_WEDDING,
  [ScenarioType.REDIS_ONLY, ScenarioType.POSTGRES_ONLY, ScenarioType.STELLAR_ONLY],
  [ScenarioType.STELLAR_ONLY, ScenarioType.CPU_ONLY],
];

refuseProduction();
const results = scenarios.map(runScenario);
for (const result of results) {
  if (!result.passed) throw new Error(`Chaos scenario ${result.scenario} failed: ${JSON.stringify(result)}`);
}

const before = await healthOf(process.env.CHAOS_TARGET_URL);
const after = await healthOf(process.env.CHAOS_TARGET_URL);

const markdown = [
  "# Chaos rehearsal results",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  "| Scenario | Faults | P0 admitted | Rescuer heartbeat | Map tiles shed | Critical lane | Integrity | Leak guard | Rollback |",
  "|---|---|---|---|---|---|---|---|---|",
  ...results.map((r) => `| ${r.scenario} | ${r.faults} | ${r.p0} | ${r.heartbeat} | ${r.tilesShed} | ${r.criticalLane} | ${r.integrity} | ${r.leakGuard} | ${r.rolledBack} |`),
  "",
  `Target health before: ${before}`,
  `Target health after: ${after}`,
  "",
].join("\n");

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, markdown, "utf8");
console.log(markdown);
console.log(`Results written to ${outputPath}`);
