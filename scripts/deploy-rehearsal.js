#!/usr/bin/env node
/**
 * Zero-downtime deploy rehearsal (#758).
 *
 * Drives the staged orchestrator with injectable stages so CI can verify
 * drain → deploy → health → cutover → rollback, WS resume-token handoff,
 * automatic rollback on a failed health check and the manual abort gate
 * without touching a real Render service.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  DeployStage,
  DeployState,
  ZeroDowntimeDeployManager,
  createStagedDeploy,
} from "../server/lib/zeroDowntimeDeploy.js";

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = join(here, "..", "artifacts", "zero-downtime-rehearsal.md");

function managerWithConnections(count = 3) {
  const manager = new ZeroDowntimeDeployManager();
  manager.migrationsApplied = true;
  manager.updateIndexerProgress(1000, 1010);
  const sockets = Array.from({ length: count }, (_, i) => ({
    lastSeenSeq: 1000 + i,
    sent: [],
    closed: false,
    send(message) { this.sent.push(JSON.parse(message)); },
    close() { this.closed = true; },
  }));
  sockets.forEach((socket) => manager.registerWsConnection(socket));
  return { manager, sockets };
}

function stagesFor({ healthOk = true } = {}) {
  return {
    migrate: async () => ({ ok: true, fenced: true }),
    indexerCatchup: async () => ({ ok: true, lag: 10 }),
    health: async () => ({ ok: healthOk, status: healthOk ? "READY" : "NOT_READY" }),
    drain: async (ctx) => {
      const result = await ctx.manager.initiateGracefulDrain();
      return { ok: true, ...result };
    },
    deploy: async () => ({ ok: true, released: true }),
    cutover: async () => ({ ok: true, cutover: true }),
    rollback: async ({ failedStage }) => ({ ok: true, reverted: true, failedStage }),
  };
}

const rows = [];

// 1. Happy path — zero failed WS handoffs.
{
  const { manager, sockets } = managerWithConnections();
  const deploy = createStagedDeploy({ manager, stages: stagesFor() });
  const result = await deploy.run({ manager });
  assert.equal(result.status, "COMPLETE");
  const handoffs = sockets.filter((s) => s.sent[0]?.type === "DEPLOY_DRAIN");
  assert.equal(handoffs.length, sockets.length, "every WS client must receive a resume token");
  assert.ok(sockets.every((s) => s.closed));
  assert.equal(manager.state, DeployState.TERMINATED);
  rows.push({ scenario: "healthy staged deploy", status: result.status, wsHandoffs: `${handoffs.length}/${sockets.length}`, rollback: "no" });
}

// 2. Failed health check — automatic rollback, no cutover.
{
  const { manager } = managerWithConnections(1);
  const deploy = createStagedDeploy({ manager, stages: stagesFor({ healthOk: false }) });
  const result = await deploy.run({ manager });
  assert.equal(result.status, "ROLLED_BACK");
  assert.equal(result.failedStage, DeployStage.HEALTH);
  assert.ok(result.history.some((e) => e.stage === DeployStage.ROLLBACK && e.outcome === "PASSED"));
  assert.ok(!result.history.some((e) => e.stage === DeployStage.CUTOVER));
  rows.push({ scenario: "failed health check", status: result.status, wsHandoffs: "n/a", rollback: "automatic" });
}

// 3. Manual abort gate — rollback before cutover.
{
  const { manager } = managerWithConnections(1);
  const deploy = createStagedDeploy({
    manager,
    stages: stagesFor(),
    abortGate: ({ stage }) => stage === DeployStage.CUTOVER,
  });
  const result = await deploy.run({ manager });
  assert.equal(result.status, "ROLLED_BACK");
  assert.equal(result.failedStage, DeployStage.CUTOVER);
  rows.push({ scenario: "manual abort gate", status: result.status, wsHandoffs: "n/a", rollback: "automatic" });
}

const markdown = [
  "# Zero-downtime deploy rehearsal",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  "| Scenario | Result | WS handoffs | Rollback |",
  "|---|---|---|---|",
  ...rows.map((r) => `| ${r.scenario} | ${r.status} | ${r.wsHandoffs} | ${r.rollback} |`),
  "",
  "Stages verified: MIGRATE → INDEXER_CATCHUP → HEALTH → DRAIN → DEPLOY → CUTOVER, with ROLLBACK on health failure or manual abort.",
  "",
].join("\n");

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, markdown, "utf8");
console.log(markdown);
console.log(`Results written to ${outputPath}`);
