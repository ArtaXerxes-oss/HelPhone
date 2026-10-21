import { describe, it, expect } from "vitest";
import {
  lockDepth,
  buildGraph,
  compareVersions,
  mapVulns,
  deepHits,
  suggestOverrides,
  queryOSV,
} from "../scripts/transitive-vulnerability-scanner.js";

// #589 — Transitive vulnerability scanner. Offline fixture tests plus a
// stubbed OSV query (no network).

const fixtureLock = {
  packages: {
    "": { version: "1.0.0" },
    "node_modules/a": { version: "1.0.0" },
    "node_modules/a/node_modules/b": { version: "2.0.0" },
    "node_modules/a/node_modules/b/node_modules/c": { version: "3.0.0" },
  },
};

describe("lockDepth", () => {
  it("counts node_modules nesting", () => {
    expect(lockDepth("node_modules/a")).toBe(1);
    expect(lockDepth("node_modules/a/node_modules/b")).toBe(2);
  });
});

describe("buildGraph", () => {
  it("builds nodes with depth and max depth", () => {
    const g = buildGraph(fixtureLock);
    expect(g.total).toBe(3);
    expect(g.maxDepth).toBe(3);
    expect(g.nodes.find((n) => n.name === "c").depth).toBe(3);
  });
});

describe("compareVersions", () => {
  it("orders versions numerically", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(compareVersions("2.0.1", "2.0.0")).toBeGreaterThan(0);
  });
});

describe("mapVulns + deepHits + suggestOverrides", () => {
  const graph = buildGraph(fixtureLock);
  const advisories = [
    {
      package: "c",
      vulnerableBelow: "3.0.1",
      severity: "HIGH",
      cve: { fixedIn: "3.0.1" },
    },
    { package: "a", vulnerableBelow: "0.9.0", severity: "LOW" },
  ];

  it("maps advisories to exact versions", () => {
    const hits = mapVulns(graph, advisories);
    expect(hits.map((h) => h.name)).toEqual(["c"]);
  });

  it("returns empty with no advisories", () => {
    expect(mapVulns(graph, [])).toEqual([]);
  });

  it("isolates deep (>=5) hits", () => {
    const deepGraph = buildGraph({
      packages: {
        "node_modules/x/node_modules/y/node_modules/z/node_modules/w/node_modules/v":
          {
            version: "1.0.0",
          },
      },
    });
    const hits = mapVulns(deepGraph, [
      { package: "v", vulnerableBelow: "2.0.0", severity: "CRITICAL" },
    ]);
    expect(deepHits(hits).map((h) => h.name)).toEqual(["v"]);
    expect(deepHits(mapVulns(graph, advisories))).toEqual([]);
  });

  it("suggests overrides for hits", () => {
    const hits = mapVulns(graph, advisories);
    const { overrides } = suggestOverrides(hits);
    expect(Object.keys(overrides)).toEqual(["c"]);
  });
});

describe("queryOSV (stubbed fetch)", () => {
  it("degrades gracefully on network failure", async () => {
    const failing = async () => {
      throw new Error("offline");
    };
    const r = await queryOSV([{ name: "a", version: "1.0.0" }], failing, 500);
    expect(r.ok).toBe(false);
  });
});
