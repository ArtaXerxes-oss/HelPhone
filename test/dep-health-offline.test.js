import { describe, expect, it } from "vitest";
import {
  healthIndex,
  renderReport,
  scoreDependencies,
  shouldFailCi,
} from "../scripts/monitor-dep-health.js";

describe("Dependency-health scoring with offline registry fallback (#949)", () => {
  const now = new Date("2026-11-21T00:00:00.000Z");

  it("does not report a falsely low 50/100 score when dependencies are unknown", () => {
    expect(healthIndex([{ status: "unknown" }, { status: "unknown" }])).toBeNull();
    expect(
      healthIndex([
        { status: "healthy" },
        { status: "unknown" },
        { status: "unknown" },
      ]),
    ).toBe(100);
  });

  it("scores offline runs from committed cache and marks degraded=true", async () => {
    const res = await scoreDependencies({
      deps: [
        { name: "react", range: "^19.2.7" },
        { name: "uncached-pkg", range: "^1.0.0" },
      ],
      cache: {
        packages: {
          react: { version: "19.2.7", lastPublish: "2026-11-04T12:00:00.000Z" },
        },
      },
      offline: true,
      now,
    });

    expect(res.degraded).toBe(true);
    expect(res.degradedReason).toBe("offline-mode");
    expect(res.index).toBe(100);
    expect(res.results[0].source).toBe("cache");
    expect(res.results[1].status).toBe("unknown");
    expect(shouldFailCi(res)).toBe(false);

    const md = renderReport(res.results, res.index, {
      degraded: res.degraded,
      degradedReason: res.degradedReason,
    });
    expect(md).toContain("DEGRADED (offline-mode)");
    expect(md).toContain("Degraded: yes (offline-mode)");
  });

  it("falls back to cache when registry is unreachable and fails CI only on known-bad states", async () => {
    const failingFetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    const degradedOk = await scoreDependencies({
      deps: [{ name: "react", range: "^19.2.7" }],
      cache: {
        packages: {
          react: { version: "19.2.7", lastPublish: "2026-11-04T12:00:00.000Z" },
        },
      },
      offline: false,
      fetchImpl: failingFetch,
      now,
    });
    expect(degradedOk.degraded).toBe(true);
    expect(degradedOk.degradedReason).toBe("registry-unreachable");
    expect(degradedOk.results[0].source).toBe("cache-fallback");
    expect(shouldFailCi(degradedOk)).toBe(false);

    const knownBad = await scoreDependencies({
      deps: [{ name: "old-pkg", range: "^1.0.0" }],
      cache: {
        packages: {
          "old-pkg": { version: "1.0.0", lastPublish: "2024-01-01T00:00:00.000Z" },
        },
      },
      offline: true,
      now,
    });
    expect(knownBad.results[0].status).toBe("abandoned");
    expect(shouldFailCi(knownBad)).toBe(true);
  });
});
