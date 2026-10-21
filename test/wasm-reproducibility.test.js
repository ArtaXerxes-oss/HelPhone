import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// #590 — WASM reproducibility gate. Runs the real bash script against the
// committed artifact; asserts deterministic flags.

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const SCRIPT = path.join(REPO_ROOT, "scripts/verify-wasm-build.sh");

function run() {
  return execFileSync("bash", [SCRIPT], { encoding: "utf8" });
}

describe("verify-wasm-build.sh", () => {
  it("exits 0 and reports SHA-256 OK", () => {
    const out = run();
    expect(out).toMatch("SHA-256 OK");
    expect(out).toMatch("OK");
  });

  it("has a recorded sidecar hash matching the artifact", () => {
    const sidecar = fs
      .readFileSync(
        path.join(REPO_ROOT, "circuits/target/aegis.sha256"),
        "utf8",
      )
      .trim();
    expect(sidecar).toMatch(/^[0-9a-f]{64}$/);
  });

  it("requires deterministic release flags in workspace manifests", () => {
    const out = run();
    expect(out).toMatch("compiler_version pinned");
    expect(out).toMatch('opt-level = "z"');
  });
});
