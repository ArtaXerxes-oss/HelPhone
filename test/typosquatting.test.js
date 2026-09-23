import { describe, it, expect } from "vitest";
import {
  levenshtein,
  findTyposquatTarget,
  scanNames,
  checkMaintainer,
} from "../scripts/detect-typosquatting.js";

// #588 — Typosquatting gate. Offline pure-function tests plus a stubbed
// maintainer check (no network).

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("react", "react")).toBe(0);
  });

  it("counts single edits as distance 1", () => {
    expect(levenshtein("react", "reacct")).toBe(1);
    expect(levenshtein("express", "expresss")).toBe(1);
  });

  it("handles empty strings", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });
});

describe("findTyposquatTarget", () => {
  it("returns null for exact popular names", () => {
    expect(findTyposquatTarget("react")).toBeNull();
    expect(findTyposquatTarget("express")).toBeNull();
  });

  it("flags one-edit typosquats", () => {
    expect(findTyposquatTarget("reacct")).toBe("react");
    expect(findTyposquatTarget("expres")).toBe("express");
  });

  it("ignores unrelated names", () => {
    expect(findTyposquatTarget("supercluster")).toBeNull();
    expect(findTyposquatTarget("stellar-sdk")).toBeNull();
  });

  it("strips scopes before comparing", () => {
    expect(findTyposquatTarget("@scope/reacct")).toBe("react");
  });

  it("ignores short generic bases (e.g. @playwright/test vs jest)", () => {
    expect(findTyposquatTarget("@playwright/test")).toBeNull();
  });
});

describe("scanNames", () => {
  it("reports only suspicious entries", () => {
    const findings = scanNames(["react", "reacct", "express"]);
    expect(findings.map((f) => f.name)).toEqual(["reacct"]);
    expect(findings[0].target).toBe("react");
  });

  it("returns empty for a clean tree", () => {
    expect(scanNames(["react", "express", "vite"])).toEqual([]);
  });
});

describe("checkMaintainer (stubbed fetch)", () => {
  it("returns metadata on success", async () => {
    const stub = async () => ({
      ok: true,
      json: async () => ({
        version: "1.0.0",
        maintainers: [{ name: "alice" }],
        time: { modified: "2026-01-01T00:00:00.000Z" },
      }),
    });
    const r = await checkMaintainer("react", stub, 1000);
    expect(r.checked).toBe(true);
    expect(r.maintainers).toEqual(["alice"]);
  });

  it("degrades to unchecked on network failure", async () => {
    const failing = async () => {
      throw new Error("offline");
    };
    const r = await checkMaintainer("react", failing, 1000);
    expect(r.checked).toBe(false);
  });
});
