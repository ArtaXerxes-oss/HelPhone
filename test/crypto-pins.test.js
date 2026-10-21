import { describe, it, expect } from "vitest";
import fs from "node:fs";
import {
  checkCryptoPins,
  holdCryptoCore,
  parseCargoLock,
  installedCopies,
} from "../scripts/check-crypto-pins.js";

// #779 — crypto-core pin gate. Fixture-only except for the repo self-check.

const policy = JSON.parse(fs.readFileSync(new URL("../crypto-pins.json", import.meta.url), "utf8"));
const now = new Date("2026-10-17");

const lockOf = (versions) => ({
  packages: {
    "": {},
    "node_modules/@aztec/bb.js": { version: versions.bb },
    "node_modules/@noir-lang/noir_js": { version: versions.noir },
    "node_modules/@noir-lang/acvm_js": { version: versions.acvm ?? versions.noir },
    "node_modules/@noir-lang/noirc_abi": { version: versions.abi ?? versions.noir },
    "node_modules/@noir-lang/noir_js/node_modules/@noir-lang/types": { version: versions.noir },
  },
});
const pkg = { dependencies: { "@aztec/bb.js": "^0.87.9", "@noir-lang/noir_js": "^1.0.0-beta.9" } };
const good = { bb: "0.87.9", noir: "1.0.0-beta.9" };
const run = (lock, extra = {}) => checkCryptoPins({ policy, pkg, lock, now, ...extra });
const codes = (r) => r.violations.map((v) => v.code);

describe("crypto-pins policy file", () => {
  it("gives every pin a rationale, ADR and review date", () => {
    for (const p of policy.pins) {
      expect(p.rationale, p.name).toBeTruthy();
      expect(p.reviewed, p.name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(fs.existsSync(new URL(`../${p.adr}`, import.meta.url)), p.adr).toBe(true);
    }
  });

  it("matches the repository's real lockfiles", () => {
    const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    const result = checkCryptoPins({
      policy,
      pkg: JSON.parse(read("package.json")),
      lock: JSON.parse(read("package-lock.json")),
      cargoLock: read("Cargo.lock"),
      now,
    });
    expect(result.violations).toEqual([]);
  });
});

describe("checkCryptoPins", () => {
  it("passes the pinned set", () => {
    expect(run(lockOf(good))).toEqual({ violations: [], stale: [] });
  });

  it("rejects a Barretenberg minor bump that only the lockfile carries (red-team backtest)", () => {
    const r = run(lockOf({ ...good, bb: "0.88.0" }));
    expect(codes(r)).toEqual(["drift"]);
    expect(r.violations[0].message).toContain("@aztec/bb.js: package-lock.json resolves 0.88.0");
    expect(r.violations[0].message).toContain("ABI checklist");
  });

  it("rejects a mixed @noir-lang family", () => {
    const r = run(lockOf({ ...good, acvm: "1.0.0-beta.10" }));
    expect(codes(r)).toContain("coupling");
    expect(codes(r)).toContain("drift");
  });

  it("rejects a Cargo.lock Barretenberg crate that disagrees with bb.js", () => {
    const cargoLock = '[[package]]\nname = "barretenberg"\nversion = "0.54.2"\n';
    expect(codes(run(lockOf(good), { cargoLock }))).toEqual(["cargo-drift"]);
    const ok = '[[package]]\nname = "barretenberg"\nversion = "0.87.9"\n';
    expect(run(lockOf(good), { cargoLock: ok }).violations).toEqual([]);
  });

  it("reports a pin that is neither declared nor installed", () => {
    const lock = lockOf(good);
    delete lock.packages["node_modules/@aztec/bb.js"];
    expect(codes(run(lock, { pkg: { dependencies: {} } }))).toContain("missing");
  });

  it("requires rationale and review date on pins", () => {
    const bad = { ...policy, pins: policy.pins.map((p) => ({ ...p, rationale: "" })) };
    expect(codes(checkCryptoPins({ policy: bad, pkg, lock: lockOf(good), now }))).toContain("incomplete-pin");
  });

  it("escalates pins older than staleAfterDays", () => {
    const r = run(lockOf(good), { now: new Date("2027-03-25") });
    expect(r.violations).toEqual([]);
    expect(r.stale.length).toBe(policy.pins.length);
    expect(r.stale[0].message).toContain("Re-evaluate");
    expect(run(lockOf(good), { now: new Date("2027-03-01") }).stale).toEqual([]);
  });
});

describe("holdCryptoCore", () => {
  const patch = (name) => ({ name, from: "1.0.0", to: "1.0.1", advisories: ["GHSA-x"], severity: "high", strategy: "manifest" });

  it("never lets crypto-core packages through to auto-apply", () => {
    const plan = { patches: [patch("@aztec/bb.js"), patch("lodash")], unresolved: [] };
    const out = holdCryptoCore(plan, policy);
    expect(out.patches.map((p) => p.name)).toEqual(["lodash"]);
    expect(out.unresolved.map((p) => p.name)).toEqual(["@aztec/bb.js"]);
    expect(out.unresolved[0].reason).toContain("manual review");
  });

  it("keeps existing unresolved entries", () => {
    const keep = { ...patch("minimist"), reason: "x" };
    const out = holdCryptoCore({ patches: [], unresolved: [keep] }, policy);
    expect(out.unresolved).toEqual([keep]);
  });
});

describe("helpers", () => {
  it("parses Cargo.lock packages", () => {
    expect(parseCargoLock('[[package]]\nname = "a"\nversion = "1.2.3"\n\n[[package]]\nname = "b"\nversion = "0.1.0"\n')).toEqual([
      { name: "a", version: "1.2.3" },
      { name: "b", version: "0.1.0" },
    ]);
  });

  it("finds hoisted and nested copies", () => {
    expect(installedCopies(lockOf(good), "@noir-lang/types")).toHaveLength(1);
  });
});
