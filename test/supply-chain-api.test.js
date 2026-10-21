// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeSupplyChainReport,
  createSupplyChainRouters,
  grade,
  vulnerabilityScore,
} from "../server/routes/supplyChainSecurity.ts";
import {
  renderPrometheus,
  requestMetrics,
  resetRequestMetrics,
} from "../server/middleware/metrics.ts";
import { server as mswServer } from "../src/mocks/server.js";

// These tests drive real Express apps over supertest; keep MSW out of the way.
beforeAll(() => mswServer.close());

const SHA512 = "sha512-" + "A".repeat(86) + "==";

function makeFixture({ packages, audit, pkgJson } = {}) {
  const root = mkdtempSync(join(tmpdir(), "supply-chain-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      pkgJson ?? { dependencies: { "left-pad": "1.0.0" }, devDependencies: {} },
    ),
  );
  if (packages !== null) {
    writeFileSync(
      join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "fixture" },
          ...(packages ?? {
            "node_modules/left-pad": {
              version: "1.0.0",
              resolved:
                "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz",
              integrity: SHA512,
              license: "MIT",
              funding: { url: "https://example.org" },
            },
            "node_modules/old-lib": {
              version: "0.1.0",
              resolved:
                "https://registry.npmjs.org/old-lib/-/old-lib-0.1.0.tgz",
              integrity: SHA512,
              license: "Apache-2.0",
              deprecated: "no longer maintained",
            },
          }),
        },
      }),
    );
  }
  if (audit)
    writeFileSync(join(root, "security-audit.json"), JSON.stringify(audit));
  return root;
}

const cleanAudit = {
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
    },
  },
};

describe("supply chain report", () => {
  const roots = [];
  const fixture = (o) => {
    const r = makeFixture(o);
    roots.push(r);
    return r;
  };
  afterAll(() =>
    roots.forEach((r) => rmSync(r, { recursive: true, force: true })),
  );

  it("scores a clean, fully hashed tree as grade A and not partial", () => {
    const r = computeSupplyChainReport({
      root: fixture({ audit: cleanAudit }),
    });
    expect(r.lockfile.present).toBe(true);
    expect(r.lockfile.integrityCoverage).toBe(100);
    expect(r.lockfile.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.vulnerabilities.source).toBe("npm-audit");
    expect(r.licenses.complianceScore).toBe(100);
    expect(r.sustainability.deprecated).toEqual(["old-lib@0.1.0"]);
    expect(r.sustainability.fundingCoverage).toBe(50);
    expect(r.index.partial).toBe(false);
    expect(r.index.grade).toBe("A");
  });

  it("marks the index partial instead of assuming zero CVEs when no audit report exists", () => {
    const r = computeSupplyChainReport({ root: fixture() });
    expect(r.vulnerabilities).toEqual({
      source: "unavailable",
      reportAgeSeconds: null,
      counts: null,
    });
    expect(r.index.partial).toBe(true);
    expect(r.index.components.vulnerabilities).toBeNull();
  });

  it("treats a malformed audit report as unavailable rather than throwing", () => {
    const root = fixture();
    writeFileSync(join(root, "security-audit.json"), "{not json");
    expect(computeSupplyChainReport({ root }).vulnerabilities.source).toBe(
      "unavailable",
    );
  });

  it("penalises critical CVEs heavily", () => {
    const audit = {
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 1,
          critical: 2,
          total: 3,
        },
      },
    };
    const r = computeSupplyChainReport({ root: fixture({ audit }) });
    expect(r.vulnerabilities.counts.critical).toBe(2);
    expect(r.index.components.vulnerabilities).toBe(5);
    expect(r.index.score).toBeLessThan(70);
  });

  it("flags missing integrity hashes, weak hashes and non-registry sources", () => {
    const r = computeSupplyChainReport({
      root: fixture({
        audit: cleanAudit,
        packages: {
          "node_modules/a": {
            version: "1.0.0",
            resolved: "https://registry.npmjs.org/a.tgz",
            integrity: SHA512,
            license: "MIT",
          },
          "node_modules/b": {
            version: "1.0.0",
            resolved: "git+ssh://git@github.com/x/b.git",
            license: "MIT",
          },
          "node_modules/c": {
            version: "1.0.0",
            resolved: "https://registry.npmjs.org/c.tgz",
            integrity: "sha1-abc=",
            license: "MIT",
          },
          "node_modules/ws-link": { link: true, resolved: "server" },
        },
      }),
    });
    expect(r.lockfile.packages).toBe(3);
    expect(r.lockfile.withIntegrity).toBe(2);
    expect(r.lockfile.weakIntegrity).toBe(1);
    expect(r.lockfile.nonRegistrySources).toEqual([
      "b <- git+ssh://git@github.com/x/b.git",
    ]);
    expect(r.index.components.lockfileIntegrity).toBeLessThan(
      r.lockfile.integrityCoverage,
    );
  });

  it("zeroes license compliance when a non-excepted GPL dependency appears", () => {
    const r = computeSupplyChainReport({
      root: fixture({
        audit: cleanAudit,
        packages: {
          "node_modules/copyleft": {
            version: "2.0.0",
            integrity: SHA512,
            license: "GPL-3.0-only",
          },
          "node_modules/fine": {
            version: "1.0.0",
            integrity: SHA512,
            license: "MIT",
          },
        },
      }),
    });
    expect(r.licenses.denied).toBe(1);
    expect(r.licenses.deniedPackages).toEqual([
      "copyleft@2.0.0 (GPL-3.0-only)",
    ]);
    expect(r.index.components.licenseCompliance).toBe(0);
  });

  it("scores integrity as zero when there is no lockfile", () => {
    const r = computeSupplyChainReport({
      root: fixture({ packages: null, audit: cleanAudit }),
    });
    expect(r.lockfile.present).toBe(false);
    expect(r.index.components.lockfileIntegrity).toBe(0);
  });

  it("grades and scores at the documented thresholds", () => {
    expect([95, 85, 75, 65, 10].map(grade)).toEqual(["A", "B", "C", "D", "F"]);
    expect(
      vulnerabilityScore({
        info: 9,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 9,
      }),
    ).toBe(100);
    expect(
      vulnerabilityScore({
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 3,
        total: 3,
      }),
    ).toBe(0);
  });
});

describe("prometheus rendering", () => {
  it("renders HELP/TYPE headers and escapes label values", () => {
    const text = renderPrometheus([
      {
        name: "x_total",
        help: "line1\nline2",
        type: "counter",
        samples: [{ labels: { route: 'a"b\\c' }, value: 3 }],
      },
    ]);
    expect(text).toBe(
      '# HELP x_total line1\\nline2\n# TYPE x_total counter\nx_total{route="a\\"b\\\\c"} 3\n',
    );
  });

  it("rejects invalid metric names", () => {
    expect(() =>
      renderPrometheus([
        { name: "bad-name", help: "", type: "gauge", samples: [] },
      ]),
    ).toThrow();
  });
});

describe("supply chain HTTP endpoints", () => {
  let app;
  let root;

  beforeEach(() => {
    resetRequestMetrics();
    root = makeFixture({
      audit: {
        metadata: {
          vulnerabilities: {
            info: 0,
            low: 2,
            moderate: 1,
            high: 0,
            critical: 0,
            total: 3,
          },
        },
      },
    });
    const { api, metrics } = createSupplyChainRouters({ root, ttlMs: 0 });
    app = express();
    app.use(requestMetrics);
    app.use("/api/supply-chain", api);
    app.use("/metrics", metrics);
  });

  it("GET /api/supply-chain returns the JSON report", async () => {
    const res = await request(app).get("/api/supply-chain");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.vulnerabilities.counts).toMatchObject({
      low: 2,
      moderate: 1,
      total: 3,
    });
    expect(res.body.index.grade).toMatch(/^[A-F]$/);
  });

  it("GET /metrics/security exposes Prometheus gauges and request counters", async () => {
    await request(app).get("/api/supply-chain");
    const res = await request(app).get("/metrics/security");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(
      /^text\/plain;.*version=0\.0\.4/,
    );
    expect(res.text).toMatch(
      /^helphone_supply_chain_security_index \d+(\.\d+)?$/m,
    );
    expect(res.text).toContain(
      'helphone_dependency_vulnerabilities{severity="low"} 2',
    );
    expect(res.text).toContain(
      'helphone_dependency_licenses{status="approved"} 2',
    );
    expect(res.text).toContain(
      'helphone_http_requests_total{method="GET",route="/api/supply-chain/",status="200"} 1',
    );
  });

  it("GET /api/supply-chain/dashboard serves a locked-down HTML dashboard", async () => {
    const res = await request(app).get("/api/supply-chain/dashboard");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    expect(res.text).toContain("Supply Chain Security");
    expect(res.text).toContain("old-lib@0.1.0");
  });

  it("escapes package names in the dashboard", async () => {
    const evil = makeFixture({
      packages: {
        "node_modules/<script>x</script>": {
          version: "1",
          integrity: SHA512,
          license: "MIT",
          deprecated: "y",
        },
      },
    });
    const { api } = createSupplyChainRouters({ root: evil, ttlMs: 0 });
    const a = express().use("/d", api);
    const res = await request(a).get("/d/dashboard");
    expect(res.text).not.toContain("<script>x</script>");
    expect(res.text).toContain("&lt;script&gt;x&lt;/script&gt;");
  });
});
