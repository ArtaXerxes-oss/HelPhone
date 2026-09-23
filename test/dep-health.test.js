import { describe, it, expect } from "vitest";
import {
  ABANDONED_MONTHS,
  monthsSince,
  classifyDep,
  healthIndex,
  renderReport,
  fetchNpmMeta,
} from "../scripts/monitor-dep-health.js";

// #591 — Dependency health monitor. Fixed-clock tests (no network).

const NOW = new Date("2026-09-23T00:00:00.000Z");

describe("ABANDONED_MONTHS", () => {
  it("uses the 12-month abandonment threshold", () => {
    expect(ABANDONED_MONTHS).toBe(12);
  });
});

describe("monthsSince", () => {
  it("measures elapsed months", () => {
    expect(monthsSince("2026-08-23T00:00:00.000Z", NOW)).toBeCloseTo(1, 0);
    expect(monthsSince("2025-09-23T00:00:00.000Z", NOW)).toBeCloseTo(12, 0);
  });

  it("returns null for missing/invalid dates", () => {
    expect(monthsSince(null, NOW)).toBeNull();
    expect(monthsSince("not-a-date", NOW)).toBeNull();
  });
});

describe("classifyDep", () => {
  it("flags packages untouched for over 12 months as abandoned", () => {
    expect(classifyDep({ lastPublish: "2024-01-01T00:00:00.000Z" }, NOW)).toBe(
      "abandoned",
    );
  });

  it("marks recent publishes healthy", () => {
    expect(classifyDep({ lastPublish: "2026-09-01T00:00:00.000Z" }, NOW)).toBe(
      "healthy",
    );
  });

  it("marks 6–12 month gaps stale", () => {
    expect(classifyDep({ lastPublish: "2026-01-01T00:00:00.000Z" }, NOW)).toBe(
      "stale",
    );
  });

  it("marks unknown when registry data is missing", () => {
    expect(classifyDep({}, NOW)).toBe("unknown");
  });
});

describe("healthIndex", () => {
  it("scores 100 for all-healthy", () => {
    expect(healthIndex([{ status: "healthy" }, { status: "healthy" }])).toBe(
      100,
    );
  });

  it("scores 0 for all-abandoned", () => {
    expect(healthIndex([{ status: "abandoned" }])).toBe(0);
  });

  it("returns 100 for an empty tree", () => {
    expect(healthIndex([])).toBe(100);
  });
});

describe("renderReport", () => {
  it("renders index and abandoned section", () => {
    const body = renderReport(
      [
        {
          name: "old-pkg",
          range: "^1.0.0",
          lastPublish: "2020-01-01",
          status: "abandoned",
        },
      ],
      0,
    );
    expect(body).toMatch("Health index: 0/100");
    expect(body).toMatch("old-pkg");
  });
});

describe("fetchNpmMeta (stubbed fetch)", () => {
  it("degrades gracefully on network failure", async () => {
    const failing = async () => {
      throw new Error("offline");
    };
    const r = await fetchNpmMeta("react", failing, 500);
    expect(r.ok).toBe(false);
  });
});
