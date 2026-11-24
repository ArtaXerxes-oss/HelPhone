#!/usr/bin/env node
/**
 * record-drill-evidence.js (#952)
 *
 * Evaluates a fire-drill JSON report, writes bus-factor graduation evidence to
 * docs/evidence/fire-drills/latest.json (for quarterly refresh linking), and
 * opens a tracked remediation task in TODO.md when any drill fails.
 *
 * Usage:
 *   node scripts/record-drill-evidence.js --report artifacts/fire-drill-report.json [--archive] [--record-failure-task]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_EVIDENCE_DIR = path.join(REPO_ROOT, "docs", "evidence", "fire-drills");
const DEFAULT_TODO_PATH = path.join(REPO_ROOT, "TODO.md");

export function evaluateDrillReport(report) {
  if (!report || typeof report !== "object") {
    throw new Error("Invalid fire-drill report: expected object");
  }
  const drills = Array.isArray(report.drills)
    ? report.drills
    : [
        {
          name: report.scenario || "backup-restore",
          passed: report.passed !== false,
          durationSeconds: Number(report.durationSeconds ?? 0),
          maxSeconds: Number(report.maxSeconds ?? 300),
          startedAt: report.startedAt || null,
          endedAt: report.endedAt || null,
          criteria: "backup_restore_completed",
        },
      ];

  const evaluated = drills.map((d) => {
    const withinSla =
      typeof d.maxSeconds !== "number" || d.durationSeconds <= d.maxSeconds;
    const passed = Boolean(d.passed) && withinSla;
    return {
      name: String(d.name),
      passed,
      withinSla,
      durationSeconds: Number(d.durationSeconds ?? 0),
      maxSeconds: typeof d.maxSeconds === "number" ? d.maxSeconds : null,
      criteria: d.criteria || "unspecified",
      startedAt: d.startedAt || report.startedAt || null,
      endedAt: d.endedAt || report.endedAt || null,
    };
  });

  const failedDrills = evaluated.filter((d) => !d.passed).map((d) => d.name);
  return {
    passed: Boolean(report.passed !== false) && failedDrills.length === 0,
    failedDrills,
    drills: evaluated,
    scenario: report.scenario || "all",
    dryRun: Boolean(report.dryRun),
    target: report.target || "unknown",
    startedAt: report.startedAt || null,
    endedAt: report.endedAt || null,
    durationSeconds: Number(report.durationSeconds ?? 0),
  };
}

export function appendFailureTasksToTodo(
  evaluation,
  { todoPath = DEFAULT_TODO_PATH, now = new Date().toISOString().slice(0, 10) } = {},
) {
  if (evaluation.passed || evaluation.failedDrills.length === 0) {
    return { added: [] };
  }
  const existing = fs.existsSync(todoPath)
    ? fs.readFileSync(todoPath, "utf8")
    : "# TODO\n";
  const sectionHeader = "## Fire-Drill Remediation Tasks";
  const added = [];
  let updated = existing;

  if (!updated.includes(sectionHeader)) {
    updated = `${updated.trimEnd()}\n\n${sectionHeader}\n\n`;
  }

  for (const drillName of evaluation.failedDrills) {
    const marker = `fire-drill:${drillName}`;
    const alreadyOpen = new RegExp(`- \\[ \\][^\\n]*${marker}`).test(updated);
    if (alreadyOpen) continue;

    const drillInfo = evaluation.drills.find((d) => d.name === drillName);
    const detail = drillInfo
      ? `duration=${drillInfo.durationSeconds}s (max=${drillInfo.maxSeconds ?? "n/a"}s), criteria=${drillInfo.criteria}`
      : "criteria failed";
    const entry =
      `- [ ] Remediate failed \`${drillName}\` fire-drill (${now}) <!-- ${marker} | subsystem: db | mentor: @helphone-db-owner | ladder: 3 -->\n` +
      `  Failure detail: ${detail}. Re-run \`scripts/fire-drill.sh --scenario ${drillName}\` after fix.\n`;
    updated = `${updated.trimEnd()}\n\n${entry}`;
    added.push(drillName);
  }

  if (added.length > 0) {
    fs.writeFileSync(todoPath, `${updated.trimEnd()}\n`);
  }
  return { added };
}

export function recordEvidence(
  report,
  {
    evidenceDir = DEFAULT_EVIDENCE_DIR,
    archive = false,
    recordFailureTask = false,
    todoPath = DEFAULT_TODO_PATH,
    recordedAt = new Date().toISOString(),
  } = {},
) {
  const evaluation = evaluateDrillReport(report);
  const evidence = {
    schemaVersion: 1,
    recordedAt,
    subsystem: "Indexer / DB",
    busFactorLedgerRef: "docs/bus-factor-ledger.md",
    ...evaluation,
  };

  fs.mkdirSync(evidenceDir, { recursive: true });
  const latestPath = path.join(evidenceDir, "latest.json");
  fs.writeFileSync(latestPath, `${JSON.stringify(evidence, null, 2)}\n`);

  let archivePath = null;
  if (archive) {
    const stamp = recordedAt.slice(0, 10);
    archivePath = path.join(evidenceDir, `${stamp}-${evaluation.scenario}.json`);
    fs.writeFileSync(archivePath, `${JSON.stringify(evidence, null, 2)}\n`);
  }

  let todoResult = { added: [] };
  if (recordFailureTask && !evaluation.passed) {
    todoResult = appendFailureTasksToTodo(evaluation, {
      todoPath,
      now: recordedAt.slice(0, 10),
    });
  }

  return { evidence, latestPath, archivePath, todoResult };
}

function parseArgs(argv) {
  const opts = {
    report: null,
    archive: false,
    recordFailureTask: false,
    evidenceDir: DEFAULT_EVIDENCE_DIR,
    todoPath: DEFAULT_TODO_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") opts.report = argv[++i];
    else if (a === "--archive") opts.archive = true;
    else if (a === "--record-failure-task") opts.recordFailureTask = true;
    else if (a === "--evidence-dir") opts.evidenceDir = path.resolve(argv[++i]);
    else if (a === "--todo") opts.todoPath = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.report) {
    console.error(
      "Usage: node scripts/record-drill-evidence.js --report <fire-drill-report.json> [--archive] [--record-failure-task]",
    );
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(path.resolve(opts.report), "utf8"));
  const res = recordEvidence(raw, opts);
  console.log(
    `[fire-drill-evidence] recorded -> ${path.relative(REPO_ROOT, res.latestPath)} (passed=${res.evidence.passed})`,
  );
  if (res.todoResult.added.length > 0) {
    console.log(
      `[fire-drill-evidence] opened TODO task(s): ${res.todoResult.added.join(", ")}`,
    );
  }
  process.exit(res.evidence.passed ? 0 : 1);
}
