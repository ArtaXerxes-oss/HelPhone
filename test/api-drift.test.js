import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  normalizeSignature,
  classifyUpgrade,
  isExactNpmPin,
  isExactCargoPin,
  isInternalMemberName,
  diffSurface,
  evaluateDrift,
  parseCargoManifest,
  checkCargoPinning,
  extractSurface,
  resolveTypesEntry,
  readPackageMeta,
  extractPackageSurfaces,
  loadConfig,
  runCheck,
  runUpdate,
  REPO_ROOT,
} from "../scripts/detect-api-drift.js";

// Automated dependency version drift & breaking API change analyzer.
// Everything here is offline: surfaces come from in-memory .d.ts fixtures or
// from temp-dir package layouts, the real package.json / tsconfig / Cargo.toml
// are only read for structural assertions.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "detect-api-drift.js");
const SLOW = { timeout: 60_000 };

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// ---------------------------------------------------------------------------
// Signature normalization
// ---------------------------------------------------------------------------

describe("normalizeSignature", () => {
  it("collapses whitespace so formatting differences are not drift", () => {
    expect(normalizeSignature("  (a:   string,\n\t b: number)  =>  void ")).toBe("(a: string, b: number) => void");
  });

  it("rewrites absolute import() specifiers to a stable node_modules form", () => {
    expect(normalizeSignature('import("/home/ci/work/node_modules/lodash/index.d.ts")')).toBe('import("lodash/index.d.ts")');
    expect(normalizeSignature('import("lodash")')).toBe('import("lodash")');
  });

  it("handles empty input", () => {
    expect(normalizeSignature(undefined)).toBe("");
    expect(normalizeSignature(null)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Version classification & pin helpers
// ---------------------------------------------------------------------------

describe("classifyUpgrade", () => {
  it("classifies major / minor / patch movement", () => {
    expect(classifyUpgrade("1.0.0", "2.0.0")).toBe("major");
    expect(classifyUpgrade("1.4.0", "1.5.0")).toBe("minor");
    expect(classifyUpgrade("1.4.0", "1.4.1")).toBe("patch");
    expect(classifyUpgrade("1.4.1", "1.4.1")).toBe("none");
  });

  it("flags downgrades and unparseable versions", () => {
    expect(classifyUpgrade("2.0.0", "1.9.9")).toBe("downgrade");
    expect(classifyUpgrade(null, "1.0.0")).toBe("unknown");
    expect(classifyUpgrade("latest", "1.0.0")).toBe("unknown");
  });
});

describe("version pin helpers", () => {
  it("accepts only exact npm versions", () => {
    expect(isExactNpmPin("1.2.3")).toBe(true);
    expect(isExactNpmPin("1.2.3-rc.1")).toBe(true);
    expect(isExactNpmPin("^1.2.3")).toBe(false);
    expect(isExactNpmPin("~1.2")).toBe(false);
    expect(isExactNpmPin(">=1.2.3")).toBe(false);
    expect(isExactNpmPin("1.x")).toBe(false);
    expect(isExactNpmPin("workspace:*")).toBe(false);
    expect(isExactNpmPin("")).toBe(false);
  });

  it("requires the = prefix for cargo (bare 1.2.3 means ^1.2.3)", () => {
    expect(isExactCargoPin("=1.2.3")).toBe(true);
    expect(isExactCargoPin("=1.2.3-rc.1")).toBe(true);
    expect(isExactCargoPin("1.2.3")).toBe(false);
    expect(isExactCargoPin("^1.2.3")).toBe(false);
    expect(isExactCargoPin("1.2")).toBe(false);
    expect(isExactCargoPin("")).toBe(false);
  });

  it("drops TypeScript well-known symbol member names (unstable ids)", () => {
    expect(isInternalMemberName("__@captureRejectionSymbol@123")).toBe(true);
    expect(isInternalMemberName("__@iterator@42")).toBe(true);
    expect(isInternalMemberName("on")).toBe(false);
    expect(isInternalMemberName("constructor")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Surface diff
// ---------------------------------------------------------------------------

describe("diffSurface", () => {
  const before = { keep: "function: (): void", drop: "const: string", retype: "function: (): void" };
  const after = { keep: "function: (): void", retype: "function: (): Promise<void>", added: "const: number" };

  it("separates breaking changes from additive ones", () => {
    const { breaking, additive } = diffSurface(before, after);
    expect(breaking).toEqual([
      { type: "removed", key: "drop", before: "const: string" },
      { type: "changed", key: "retype", before: "function: (): void", after: "function: (): Promise<void>" },
    ]);
    expect(additive).toEqual([{ type: "added", key: "added", after: "const: number" }]);
  });

  it("reports nothing when the surfaces are identical", () => {
    expect(diffSurface(before, { ...before })).toEqual({ breaking: [], additive: [] });
    expect(diffSurface({}, {})).toEqual({ breaking: [], additive: [] });
  });
});

// ---------------------------------------------------------------------------
// Version pinning guard
// ---------------------------------------------------------------------------

describe("evaluateDrift (version pinning guard)", () => {
  const base = { name: "pkg", range: "^1.2.0", baselineVersion: "1.2.0", installedVersion: "1.2.0" };

  it("fails when a package has no reviewed baseline", () => {
    const result = evaluateDrift({ ...base, hasBaseline: false });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain("missing-baseline");
  });

  it("rejects a breaking change inside a semver-compatible upgrade", () => {
    const breaking = [{ type: "removed", key: "run", before: "function: (): void" }];
    for (const [installedVersion, upgrade] of [
      ["1.2.1", "patch"],
      ["1.3.0", "minor"],
      ["1.2.0", "none"],
    ]) {
      const result = evaluateDrift({ ...base, installedVersion, breaking });
      expect(result.upgrade).toBe(upgrade);
      expect(result.ok).toBe(false);
      const finding = result.findings.find((f) => f.code === "breaking-compatible-upgrade");
      expect(finding, `${installedVersion} must be rejected`).toBeDefined();
      expect(finding.level).toBe("error");
      expect(finding.message).toContain("-run");
      expect(finding.message).toContain('Pin pkg to "1.2.0"');
    }
  });

  it("allows breaking changes in a major upgrade but reports them", () => {
    const breaking = [{ type: "removed", key: "run", before: "function: (): void" }];
    const result = evaluateDrift({ ...base, installedVersion: "2.0.0", breaking });
    expect(result.upgrade).toBe("major");
    expect(result.ok).toBe(true);
    const finding = result.findings.find((f) => f.code === "breaking-major-upgrade");
    expect(finding.level).toBe("warning");
    expect(finding.message).toContain("1.2.0 → 2.0.0");
  });

  it("reports clean upgrades as ok with no findings", () => {
    const result = evaluateDrift({
      ...base,
      installedVersion: "1.9.0",
      additive: [{ type: "added", key: "extra", after: "const: number" }],
    });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.upgrade).toBe("minor");
  });

  it("enforces exact pins only when requested", () => {
    expect(evaluateDrift({ ...base, requireExactPin: true }).findings.map((f) => f.code)).toContain("range-not-exact");
    expect(evaluateDrift({ ...base, requireExactPin: false }).findings).toEqual([]);
    expect(
      evaluateDrift({ ...base, range: "1.2.0", requireExactPin: true }).findings.map((f) => f.code),
    ).toEqual([]);
  });

  it("classifies drift that comes from a DefinitelyTyped bump", () => {
    const result = evaluateDrift({
      ...base,
      installedVersion: "4.22.2",
      baselineTypesVersion: "4.17.20",
      typesPackage: "@types/express",
      typesVersion: "4.17.21",
      breaking: [{ type: "removed", key: "handler", before: "function: (): void" }],
    });
    expect(result.upgrade).toBe("patch");
    expect(result.ok).toBe(false);
    const finding = result.findings.find((f) => f.code === "breaking-compatible-upgrade");
    expect(finding.message).toContain("4.17.20 → 4.17.21");
    expect(finding.message).toContain("via @types/express");
    expect(finding.message).toContain('Pin @types/express to "4.17.20"');
  });

  it("falls back to runtime versions when the types package is unchanged", () => {
    const result = evaluateDrift({
      ...base,
      installedVersion: "1.3.0",
      baselineTypesVersion: "4.17.21",
      typesPackage: "@types/express",
      typesVersion: "4.17.21",
    });
    expect(result.upgrade).toBe("minor");
    expect(result.findings).toEqual([]);
    expect(result.typesPackage).toBe("@types/express");
  });
});

// ---------------------------------------------------------------------------
// Rust half
// ---------------------------------------------------------------------------

const CARGO_PINNED = `
[package]
name = "fixture"
version = "0.1.0"

[workspace]
members = ["crates/*"]

[workspace.dependencies]
soroban-sdk = "=2.3.0"
serde = { version = "=1.0.200", features = ["derive"] }

[workspace.metadata.api-drift]
require-exact-pin = true
protected-crates = ["soroban-sdk"]
`;

describe("parseCargoManifest", () => {
  it("reads sections, arrays, inline tables and strips comments", () => {
    const { sections, error } = parseCargoManifest(CARGO_PINNED);
    expect(error).toBeNull();
    expect(sections.package.name).toBe("fixture");
    expect(sections.workspace.members).toEqual(["crates/*"]);
    expect(sections["workspace.dependencies"]["soroban-sdk"]).toBe("=2.3.0");
    expect(sections["workspace.dependencies"].serde).toEqual({ version: "=1.0.200", features: ["derive"] });
    expect(sections["workspace.metadata.api-drift"]["require-exact-pin"]).toBe(true);
    expect(sections["workspace.metadata.api-drift"]["protected-crates"]).toEqual(["soroban-sdk"]);
  });

  it("surfaces unparsable lines instead of silently skipping them", () => {
    const { error } = parseCargoManifest("[package]\nthis is not toml\n");
    expect(error).toContain("unparsable line");
  });
});

describe("checkCargoPinning", () => {
  it("requires the [workspace.metadata.api-drift] guard section", () => {
    const result = checkCargoPinning('[package]\nname = "x"\n');
    expect(result.ok).toBe(false);
    expect(result.findings[0].code).toBe("missing-guard-config");
  });

  it("fails unpinned requirements when require-exact-pin is on", () => {
    const result = checkCargoPinning('[workspace.metadata.api-drift]\nrequire-exact-pin = true\n\n[workspace.dependencies]\nfoo = "1.2.3"\n');
    expect(result.ok).toBe(false);
    expect(result.findings[0].code).toBe("range-not-exact");
    expect(result.findings[0].message).toContain('"=1.2.3"');
  });

  it("passes when every requirement carries an exact = pin", () => {
    const result = checkCargoPinning(CARGO_PINNED);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.config.requireExactPin).toBe(true);
  });

  it("leaves unpinned crates alone unless they are protected", () => {
    const manifest = `
[workspace.metadata.api-drift]
require-exact-pin = false
protected-crates = ["soroban-sdk"]

[workspace.dependencies]
soroban-sdk = "2.3.0"
serde = "1.0.200"
`;
    const result = checkCargoPinning(manifest);
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].message).toContain("soroban-sdk");
    expect(checkCargoPinning(manifest, { protectedCrates: [] }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Type surface extraction (in-memory declaration files)
// ---------------------------------------------------------------------------

const V1 = {
  "/pkg/index.d.ts": `
export interface Options {
  retries: number;
  label?: string;
}
export declare function run(opts: Options): void;
export declare class Runner {
  start(): void;
  stop(): Promise<void>;
}
export declare const VERSION: string;
export default function fallback(): void;
`,
};

const V2 = {
  "/pkg/index.d.ts": `
export interface Options {
  retries: string;
  label?: string;
}
export declare function run(opts: Options): Promise<void>;
export declare class Runner {
  start(): void;
  pause(): void;
}
export declare const VERSION: string;
export default function fallback(): void;
`,
};

const EXPORT_EQUALS = {
  "/eq/index.d.ts": `
interface Client { get(path: string): Promise<string>; }
declare function create(url: string): Client;
declare namespace create {
  const version: string;
  type Factory = (u: string) => Client;
}
export = create;
`,
};

describe("type surface extraction", () => {
  it("captures interfaces, methods, call signatures and constants", () => {
    const surface = extractSurface({ entryFile: "/pkg/index.d.ts", files: V1 });
    expect(surface).toEqual({
      Options: "interface: Options",
      "Options.label": "?string",
      "Options.retries": "number",
      Runner: "class: Runner",
      "Runner.start": "() => void",
      "Runner.stop": "() => Promise<void>",
      VERSION: "const: string",
      run: "function: (opts: Options): void",
    });
    expect(Object.keys(surface)).toEqual([...Object.keys(surface)].sort());
  });

  it("turns a semver-compatible signature change into a breaking diff", () => {
    const before = extractSurface({ entryFile: "/pkg/index.d.ts", files: V1 });
    const after = extractSurface({ entryFile: "/pkg/index.d.ts", files: V2 });
    const { breaking, additive } = diffSurface(before, after);
    expect(breaking).toEqual(
      expect.arrayContaining([
        { type: "changed", key: "Options.retries", before: "number", after: "string" },
        { type: "changed", key: "run", before: "function: (opts: Options): void", after: "function: (opts: Options): Promise<void>" },
        { type: "removed", key: "Runner.stop", before: "() => Promise<void>" },
      ]),
    );
    expect(breaking).toHaveLength(3);
    expect(additive).toEqual([{ type: "added", key: "Runner.pause", after: "() => void" }]);

    const drift = evaluateDrift({
      name: "pkg",
      range: "^1.0.0",
      baselineVersion: "1.0.0",
      installedVersion: "1.0.1",
      breaking,
      additive,
    });
    expect(drift.ok).toBe(false);
    expect(drift.findings[0].code).toBe("breaking-compatible-upgrade");
  });

  it("describes export = modules through the module key", () => {
    const surface = extractSurface({ entryFile: "/eq/index.d.ts", files: EXPORT_EQUALS });
    expect(surface.module).toBe("function: (url: string): Client");
    expect(surface.version).toBe("const: string");
    expect(surface.Factory).toBe("type: Factory");
  });

  it("never exposes default exports as part of the surface", () => {
    const surface = extractSurface({ entryFile: "/pkg/index.d.ts", files: V1 });
    expect(Object.keys(surface)).not.toContain("default");
    expect(Object.keys(surface)).not.toContain("fallback");
  });
});

// ---------------------------------------------------------------------------
// Package layout resolution
// ---------------------------------------------------------------------------

describe("resolveTypesEntry", () => {
  let root;

  const write = (rel, contents) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "helphone-apidrift-resolve-"));
    // bundled types via "types"
    write("node_modules/bundled/package.json", JSON.stringify({ name: "bundled", version: "1.0.0", types: "index.d.ts" }));
    write("node_modules/bundled/index.d.ts", "export declare const a: number;\n");
    // type-marker package.json files must not stop the package-root walk
    write(
      "node_modules/chained/package.json",
      JSON.stringify({ name: "chained", version: "1.0.0", main: "lib/cjs/index.js" }),
    );
    write("node_modules/chained/lib/cjs/package.json", JSON.stringify({ type: "commonjs" }));
    write("node_modules/chained/lib/cjs/index.js", "module.exports = {};\n");
    write("node_modules/chained/lib/cjs/index.d.ts", "export declare const b: number;\n");
    // DefinitelyTyped fallback
    write("node_modules/untyped/package.json", JSON.stringify({ name: "untyped", version: "2.0.0", main: "index.js" }));
    write("node_modules/untyped/index.js", "module.exports = {};\n");
    write("node_modules/@types/untyped/index.d.ts", "export declare const c: number;\n");
    write("node_modules/@types/untyped/package.json", JSON.stringify({ name: "@types/untyped", version: "2.4.0" }));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uses the package's own types entry", () => {
    expect(resolveTypesEntry("bundled", root)).toBe(path.join(root, "node_modules/bundled/index.d.ts"));
  });

  it("walks past lib/cjs type markers to find the package root", () => {
    expect(resolveTypesEntry("chained", root)).toBe(path.join(root, "node_modules/chained/lib/cjs/index.d.ts"));
  });

  it("falls back to DefinitelyTyped when the package ships no types", () => {
    expect(resolveTypesEntry("untyped", root)).toBe(path.join(root, "node_modules/@types/untyped/index.d.ts"));
    expect(resolveTypesEntry("@types/untyped", root)).toBe(path.join(root, "node_modules/@types/untyped/index.d.ts"));
  });

  it("returns null when neither the package nor @types provide declarations", () => {
    expect(resolveTypesEntry("missing-package", root)).toBeNull();
  });

  it("reads installed version and type-provider metadata", () => {
    expect(readPackageMeta("bundled", root)).toMatchObject({ version: "1.0.0", entry: path.join(root, "node_modules/bundled/index.d.ts") });
    expect(readPackageMeta("untyped", root)).toMatchObject({
      version: "2.0.0",
      typesPackage: "@types/untyped",
      typesVersion: "2.4.0",
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end check/update flow against a fixture package root
// ---------------------------------------------------------------------------

describe("runCheck / runUpdate", () => {
  let root;
  const manifestPath = () => path.join(root, "package.json");

  const writeManifest = (apiDrift) => {
    fs.writeFileSync(
      manifestPath(),
      JSON.stringify(
        {
          name: "fixture-root",
          version: "0.0.1",
          dependencies: { fake: "^1.0.0" },
          ...(apiDrift ? { apiDrift } : {}),
        },
        null,
        2,
      ),
    );
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "helphone-apidrift-root-"));
    fs.mkdirSync(path.join(root, "node_modules/fake"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules/fake/package.json"),
      JSON.stringify({ name: "fake", version: "1.1.0", types: "index.d.ts" }),
    );
    fs.writeFileSync(path.join(root, "node_modules/fake/index.d.ts"), "export declare function greet(name: string): number;\n");
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ apiDrift: { compilerOptions: { target: "ES2020", strict: true } } }));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads compiler options and package config from the root", () => {
    writeManifest({ packages: ["fake"], baseline: {} });
    const config = loadConfig({ root });
    expect(config.packages).toEqual(["fake"]);
    expect(config.compilerOptions.strict).toBe(true);
    expect(config.tsconfigPath).toBe(path.join(root, "tsconfig.json"));
    expect(() => loadConfig({ root: path.join(root, "does-not-exist") })).toThrow();
  });

  it(
    "flags a semver-compatible upgrade that changed a signature, then passes after re-baselining",
    SLOW,
    () => {
      writeManifest({
        packages: ["fake"],
        baseline: { fake: { version: "1.0.0", surface: { greet: "function: (name: string): string" } } },
      });

      const first = runCheck({ root });
      expect(first.ok).toBe(false);
      const [result] = first.results;
      expect(result.installedVersion).toBe("1.1.0");
      expect(result.upgrade).toBe("minor");
      expect(result.breaking).toEqual([
        { type: "changed", key: "greet", before: "function: (name: string): string", after: "function: (name: string): number" },
      ]);
      expect(result.findings.map((f) => f.code)).toContain("breaking-compatible-upgrade");
      expect(first.cargo).toBeNull();

      runUpdate({ root });
      const manifest = readJson(manifestPath());
      expect(manifest.apiDrift.packages).toEqual(["fake"]);
      expect(manifest.apiDrift.baseline.fake.version).toBe("1.1.0");
      expect(manifest.apiDrift.baseline.fake.surface.greet).toBe("function: (name: string): number");

      const second = runCheck({ root });
      expect(second.ok).toBe(true);
      expect(second.results[0].findings).toEqual([]);
    },
  );

  it(
    "errors on a protected package that is missing or has no baseline",
    SLOW,
    () => {
      writeManifest({ packages: ["fake", "ghost"], baseline: {} });
      const outcome = runCheck({ root });
      expect(outcome.ok).toBe(false);
      const ghost = outcome.results.find((r) => r.name === "ghost");
      expect(ghost.findings).toHaveLength(1);
      expect(ghost.findings[0].code).toBe("types-unavailable");
      expect(ghost.findings[0].message).toContain("no baseline recorded");

      const fake = outcome.results.find((r) => r.name === "fake");
      expect(fake.findings.map((f) => f.code)).toContain("missing-baseline");

      expect(() => runUpdate({ root, packages: ["ghost"] })).toThrow(/cannot baseline/);
    },
  );
});

// ---------------------------------------------------------------------------
// Committed guardrail configuration
// ---------------------------------------------------------------------------

describe("committed configuration", () => {
  it("records a protected package list and baseline in package.json", () => {
    const manifest = readJson(path.join(ROOT, "package.json"));
    expect(manifest.scripts["security:api-drift"]).toBe("node scripts/detect-api-drift.js --check");
    expect(manifest.scripts["security:api-drift:update"]).toBe("node scripts/detect-api-drift.js --update");
    expect(Array.isArray(manifest.apiDrift.packages)).toBe(true);
    expect(manifest.apiDrift.packages.length).toBeGreaterThan(0);
    for (const pkg of manifest.apiDrift.packages) {
      const entry = manifest.apiDrift.baseline[pkg];
      expect(entry, `${pkg} has no baseline`).toBeDefined();
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(Object.keys(entry.surface).length).toBeGreaterThan(0);
    }
    expect(Object.keys(manifest.apiDrift.baseline).sort()).toEqual([...manifest.apiDrift.packages].sort());
  });

  it("keeps the extraction compiler options in tsconfig.json (outside compilerOptions)", () => {
    const file = path.join(ROOT, "tsconfig.json");
    const { config, error } = ts.readConfigFile(file, (p) => fs.readFileSync(p, "utf8"));
    expect(error).toBeUndefined();
    expect(config.apiDrift.compilerOptions).toMatchObject({
      target: "ES2022",
      module: "CommonJS",
      skipLibCheck: true,
      noEmit: true,
    });
    expect(config.compilerOptions).not.toHaveProperty("apiDrift");
    expect(() => ts.parseJsonConfigFileContent({ ...config, compilerOptions: config.apiDrift.compilerOptions }, ts.sys, ROOT)).not.toThrow();
  });

  it("guards the server package with its own baseline", () => {
    const manifest = readJson(path.join(ROOT, "server/package.json"));
    expect(manifest.scripts["security:api-drift"]).toContain("detect-api-drift.js");
    expect(manifest.apiDrift.packages.length).toBeGreaterThan(0);
    for (const pkg of manifest.apiDrift.packages) {
      expect(manifest.apiDrift.baseline[pkg].surface).toBeTypeOf("object");
    }
  });

  it("declares the Rust guard metadata in Cargo.toml", () => {
    const cargo = fs.readFileSync(path.join(ROOT, "Cargo.toml"), "utf8");
    const result = checkCargoPinning(cargo);
    expect(result.config).not.toBeNull();
    expect(cargo).toContain("[workspace.metadata.api-drift]");
    expect(result.findings.filter((f) => f.code === "missing-guard-config")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Real package extraction (uses the installed node_modules)
// ---------------------------------------------------------------------------

describe("real package surface extraction", () => {
  it(
    "extracts a real installed dependency and matches the committed baseline",
    SLOW,
    () => {
      const manifest = readJson(path.join(ROOT, "package.json"));
      const pkg = manifest.apiDrift.packages.find((name) => name === "cors") ?? manifest.apiDrift.packages[0];
      const { surfaces, skipped } = extractPackageSurfaces([pkg], { root: REPO_ROOT });
      expect(skipped[pkg]).toBeUndefined();

      const { surface, meta } = surfaces[pkg];
      expect(meta.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(Object.keys(surface).length).toBeGreaterThan(0);

      const committed = manifest.apiDrift.baseline[pkg].surface;
      const { breaking } = diffSurface(committed, surface);
      expect(breaking, `${pkg} drifted from its committed baseline — run npm run security:api-drift:update`).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// CLI contract
// ---------------------------------------------------------------------------

describe("CLI", () => {
  const run = (args, opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", ...opts });

  it("prints usage for --help", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--require-exact-pin");
  });

  it("rejects unknown options with exit code 2", () => {
    const result = run(["--nope"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown option: --nope");
  });

  it("emits machine readable JSON with --json", () => {
    const result = run(["--json", "--packages", "no-such-package", "--root", path.join(ROOT, "server")]);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.results[0].name).toBe("no-such-package");
    expect(payload.results[0].ok).toBe(false);
  });
});
