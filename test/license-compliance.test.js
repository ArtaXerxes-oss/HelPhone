import { describe, it, expect } from "vitest";
import {
  classifyExpression,
  classifyId,
  normalizeId,
  collectNpm,
  collectCargo,
  evaluate,
  buildManifest,
} from "../scripts/license-compliance.js";

// #586 — Dependency license compliance & copyleft gate. Fixture-only: no
// filesystem or cargo invocation.

describe("classifyId", () => {
  it("approves permissive licenses and denies strong copyleft", () => {
    expect(classifyId("MIT")).toBe("approved");
    expect(classifyId("Apache-2.0")).toBe("approved");
    expect(classifyId("GPL-3.0-only")).toBe("denied");
    expect(classifyId("AGPL-3.0-or-later")).toBe("denied");
    expect(classifyId("SSPL-1.0")).toBe("denied");
    expect(classifyId("GPL-2.0+")).toBe("denied");
  });

  it("routes weak copyleft and unknown ids to review", () => {
    expect(classifyId("LGPL-3.0-only")).toBe("review");
    expect(classifyId("MPL-2.0")).toBe("review");
    expect(classifyId("Some-Custom-License")).toBe("review");
  });

  it("normalizes aliases and license-checker guess markers", () => {
    expect(normalizeId("Apache 2.0")).toBe("Apache-2.0");
    expect(normalizeId("MIT*")).toBe("MIT");
    expect(classifyId("BSD-3-Clause*")).toBe("approved");
  });
});

describe("classifyExpression (SPDX)", () => {
  it("OR picks the most permissive branch", () => {
    expect(classifyExpression("MIT OR Apache-2.0")).toBe("approved");
    expect(classifyExpression("GPL-3.0 OR MIT")).toBe("approved");
    expect(classifyExpression("(GPL-2.0 OR LGPL-2.1)")).toBe("review");
  });

  it("AND picks the most restrictive term", () => {
    expect(classifyExpression("(MIT OR Apache-2.0) AND Unicode-3.0")).toBe("approved");
    expect(classifyExpression("MIT AND GPL-3.0")).toBe("denied");
    expect(classifyExpression("MIT AND (AGPL-3.0 OR SSPL-1.0)")).toBe("denied");
  });

  it("honours WITH exceptions and slash-separated legacy forms", () => {
    expect(classifyExpression("Apache-2.0 WITH LLVM-exception")).toBe("approved");
    expect(classifyExpression("GPL-2.0 WITH Classpath-exception-2.0")).toBe("review");
    expect(classifyExpression("MIT/Apache-2.0")).toBe("approved");
  });

  it("treats missing or non-SPDX metadata as review", () => {
    expect(classifyExpression(undefined)).toBe("review");
    expect(classifyExpression("UNKNOWN")).toBe("review");
    expect(classifyExpression("SEE LICENSE IN LICENSE.md")).toBe("review");
    expect(classifyExpression("UNLICENSED")).toBe("review");
  });
});

const fixtureLock = {
  lockfileVersion: 3,
  packages: {
    "": { name: "helphone", version: "1.0.0" },
    server: { name: "helphone-prover", version: "1.0.0" },
    "node_modules/helphone-prover": { resolved: "server", link: true },
    "node_modules/react": { version: "19.2.7", license: "MIT" },
    "node_modules/copyleft-lib": { version: "1.0.0", license: "AGPL-3.0" },
    "node_modules/a/node_modules/react": { version: "19.2.7", license: "MIT", dev: true },
    "node_modules/nolicense": { version: "0.1.0" },
    "node_modules/devtool": { version: "2.0.0", license: "GPL-2.0", dev: true },
  },
};

describe("collectNpm", () => {
  const installed = {
    "node_modules/nolicense": {
      version: "0.1.0",
      licenses: [{ type: "MIT" }, { type: "Apache-2.0" }],
      repository: { url: "git+https://github.com/x/nolicense.git" },
    },
  };
  const deps = collectNpm(fixtureLock, (p) => installed[p] || null);

  it("skips the root project and workspace links", () => {
    expect(deps.map((d) => d.name)).not.toContain("helphone-prover");
    expect(deps.map((d) => d.name)).not.toContain("server");
  });

  it("dedupes nested copies; dev only if every copy is dev", () => {
    const react = deps.filter((d) => d.name === "react");
    expect(react).toHaveLength(1);
    expect(react[0].dev).toBe(false);
  });

  it("falls back to the installed package.json licenses array", () => {
    const pkg = deps.find((d) => d.name === "nolicense");
    expect(pkg.license).toBe("(MIT OR Apache-2.0)");
    expect(pkg.repository).toBe("https://github.com/x/nolicense");
  });
});

describe("collectCargo", () => {
  it("keeps registry crates and drops workspace path crates", () => {
    const deps = collectCargo({
      packages: [
        { name: "helphone_dao", version: "0.1.0", source: null, license: null },
        {
          name: "soroban-sdk",
          version: "26.0.1",
          source: "registry+https://github.com/rust-lang/crates.io-index",
          license: "Apache-2.0",
          repository: "https://github.com/stellar/rs-soroban-sdk",
        },
        {
          name: "ring",
          version: "0.17.0",
          source: "registry+https://github.com/rust-lang/crates.io-index",
          license: null,
          license_file: "LICENSE",
        },
      ],
    });
    expect(deps.map((d) => d.name)).toEqual(["soroban-sdk", "ring"]);
    expect(deps[0]).toMatchObject({ ecosystem: "cargo", license: "Apache-2.0" });
    expect(deps[1].license).toBe("SEE LICENSE IN LICENSE");
  });
});

describe("evaluate + buildManifest", () => {
  const deps = [
    ...collectNpm(fixtureLock),
    { ecosystem: "cargo", name: "gpl-crate", version: "1.0.0", license: "GPL-3.0-only", dev: false },
  ];

  it("fails on new copyleft (dev deps included), passes excepted ones", () => {
    const result = evaluate(deps, { "npm:copyleft-lib": "legal sign-off #1" });
    expect(result.denied.map((p) => `${p.ecosystem}:${p.name}`).sort()).toEqual([
      "cargo:gpl-crate",
      "npm:devtool",
    ]);
    expect(result.excepted).toHaveLength(1);
    expect(result.excepted[0]).toMatchObject({ name: "copyleft-lib", exception: "legal sign-off #1" });
    expect(result.review.map((p) => p.name)).toEqual(["nolicense"]);
  });

  it("produces a deterministic, sorted attribution manifest", () => {
    const result = evaluate(deps, {});
    const a = buildManifest(result);
    const b = buildManifest(evaluate([...deps].reverse(), {}));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.summary).toMatchObject({ total: 5, npm: 4, cargo: 1, denied: 3, review: 1, approved: 1 });
    expect(a.packages[0].ecosystem).toBe("cargo");
    expect(a.packages.find((p) => p.name === "devtool").dev).toBe(true);
    expect(a).not.toHaveProperty("generatedAt");
  });
});
