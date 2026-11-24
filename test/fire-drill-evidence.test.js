import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  appendFailureTasksToTodo,
  evaluateDrillReport,
  recordEvidence,
} from "../scripts/record-drill-evidence.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "helphone-fire-drill-"));

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("Fire-drill automation & graduation evidence (#952)", () => {
  it("evaluates passing multi-scenario drill reports within SLA", () => {
    const evalResult = evaluateDrillReport({
      scenario: "all",
      dryRun: true,
      passed: true,
      startedAt: "2026-11-21T04:00:00Z",
      endedAt: "2026-11-21T04:01:00Z",
      durationSeconds: 60,
      target: "helphone_drill",
      drills: [
        {
          name: "lag-spike",
          passed: true,
          durationSeconds: 20,
          maxSeconds: 120,
          criteria: "indexer_lag_ledgers<=5_and_recovered_within_sla",
        },
        {
          name: "pool-exhaustion",
          passed: true,
          durationSeconds: 15,
          maxSeconds: 90,
          criteria: "idle_connections_recovered_and_healthcheck_200",
        },
        {
          name: "indexer-backfill",
          passed: true,
          durationSeconds: 25,
          maxSeconds: 180,
          criteria: "cursor_parity_verified_and_zero_missing_ledgers",
        },
      ],
    });

    expect(evalResult.passed).toBe(true);
    expect(evalResult.failedDrills).toEqual([]);
    expect(evalResult.drills).toHaveLength(3);
  });

  it("marks a drill failed when duration exceeds maxSeconds", () => {
    const evalResult = evaluateDrillReport({
      scenario: "lag-spike",
      passed: true,
      drills: [
        {
          name: "lag-spike",
          passed: true,
          durationSeconds: 150,
          maxSeconds: 120,
          criteria: "indexer_lag_ledgers<=5_and_recovered_within_sla",
        },
      ],
    });

    expect(evalResult.passed).toBe(false);
    expect(evalResult.failedDrills).toEqual(["lag-spike"]);
    expect(evalResult.drills[0].withinSla).toBe(false);
  });

  it("writes latest/archived evidence and opens a tracked TODO task on failure", () => {
    const evidenceDir = path.join(TMP, "evidence");
    const todoPath = path.join(TMP, "TODO.md");
    fs.writeFileSync(todoPath, "# TODO\n");

    const res = recordEvidence(
      {
        scenario: "all",
        passed: false,
        drills: [
          {
            name: "pool-exhaustion",
            passed: false,
            durationSeconds: 95,
            maxSeconds: 90,
            criteria: "idle_connections_recovered_and_healthcheck_200",
          },
        ],
      },
      {
        evidenceDir,
        archive: true,
        recordFailureTask: true,
        todoPath,
        recordedAt: "2026-11-21T04:05:00Z",
      },
    );

    expect(fs.existsSync(res.latestPath)).toBe(true);
    expect(fs.existsSync(res.archivePath)).toBe(true);
    expect(res.todoResult.added).toEqual(["pool-exhaustion"]);

    const todoContent = fs.readFileSync(todoPath, "utf8");
    expect(todoContent).toContain("Remediate failed `pool-exhaustion` fire-drill");
    expect(todoContent).toContain("fire-drill:pool-exhaustion");

    // Re-running does not duplicate an already open task
    const second = appendFailureTasksToTodo(
      evaluateDrillReport({
        scenario: "pool-exhaustion",
        passed: false,
        drills: [{ name: "pool-exhaustion", passed: false, durationSeconds: 95, maxSeconds: 90 }],
      }),
      { todoPath, now: "2026-11-21" },
    );
    expect(second.added).toEqual([]);
  });
});
