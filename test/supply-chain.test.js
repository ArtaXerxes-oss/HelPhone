import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { scan } from "../scripts/security/strip_executables.js";
import {
  buildReport,
  packageName,
} from "../plugins/vite-plugin-deadcode-pruner.js";
import {
  verifyProvenance,
  parseDigests,
} from "../src/utils/verifyProvenance.js";

const hex = (s) => createHash("sha256").update(s).digest("hex");

describe("strip_executables scan", () => {
  it("flags ELF/PE/shell files and honours the whitelist", () => {
    const dir = mkdtempSync(join(tmpdir(), "nm-"));
    mkdirSync(join(dir, "pkg"));
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);
    writeFileSync(join(dir, "pkg/a.node"), elf);
    writeFileSync(join(dir, "pkg/b.dll"), "MZ\x90\x00");
    writeFileSync(join(dir, "pkg/run"), "#!/bin/bash\necho hi\n");
    writeFileSync(
      join(dir, "pkg/cli.js"),
      "#!/usr/bin/env node\nconsole.log(1)\n",
    );
    writeFileSync(join(dir, "pkg/index.js"), "module.exports = 1\n");

    const found = scan(dir, { [hex(elf)]: "ok" });
    const byName = Object.fromEntries(
      found.map((f) => [f.path.split("/").pop(), f]),
    );
    expect(Object.keys(byName).sort()).toEqual(["a.node", "b.dll", "run"]);
    expect(byName["a.node"]).toMatchObject({ kind: "ELF", approved: true });
    expect(byName["b.dll"]).toMatchObject({ kind: "PE", approved: false });
    expect(byName.run.kind).toBe("shell");
  });
});

describe("deadcode pruner report", () => {
  it("resolves scoped package names", () => {
    expect(packageName("/x/node_modules/@stellar/stellar-sdk/lib/a.js")).toBe(
      "@stellar/stellar-sdk",
    );
    expect(packageName("/x/node_modules/a/node_modules/buffer/index.js")).toBe(
      "buffer",
    );
  });

  it("totals removed bytes and exports, ignoring app code", () => {
    const report = buildReport([
      {
        id: "/x/node_modules/lib/a.js",
        originalBytes: 100,
        renderedBytes: 40,
        exports: ["f", "g", "h"],
        renderedExports: ["f"],
      },
      {
        id: "/x/node_modules/lib/b.js",
        originalBytes: 50,
        renderedBytes: 0,
        exports: ["z"],
        renderedExports: [],
      },
      {
        id: "/x/src/App.tsx",
        originalBytes: 999,
        renderedBytes: 1,
        exports: ["default"],
        renderedExports: [],
      },
    ]);
    expect(report.totals).toMatchObject({
      modules: 2,
      removedBytes: 110,
      removedExports: 3,
    });
    expect(report.packages[0].removedExports).toEqual([
      "lib/a.js#g",
      "lib/a.js#h",
      "lib/b.js#z",
    ]);
  });
});

describe("verifyProvenance", () => {
  const script = 'console.log("app")';
  const digestsText = `${hex(script)}  assets/index-abc.js\n`;
  const doc = {
    querySelector: () => ({ getAttribute: () => "/assets/index-abc.js" }),
  };
  const rekorEntry = (hash) => ({
    uuid1: {
      body: btoa(JSON.stringify({ spec: { data: { hash: { value: hash } } } })),
    },
  });
  const res = (body) => ({
    ok: true,
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  });
  const fetchWith =
    (overrides = {}) =>
    async (url) => {
      if (url === "/provenance.json")
        return res({ commit: "abc123", rekorLogIndex: 42 });
      if (url === "/digests.txt") return res(overrides.digests ?? digestsText);
      if (url === "/assets/index-abc.js")
        return res(overrides.script ?? script);
      if (url.includes("rekor")) return res(rekorEntry(hex(digestsText)));
      return { ok: false };
    };

  it("parses sha256sum output", () => {
    expect(parseDigests(digestsText)).toEqual({
      "assets/index-abc.js": hex(script),
    });
  });

  it("verifies a matching bundle logged in Rekor", async () => {
    expect(await verifyProvenance({ fetchImpl: fetchWith(), doc })).toEqual({
      status: "verified",
      commit: "abc123",
    });
  });

  it("rejects a tampered bundle", async () => {
    const r = await verifyProvenance({
      fetchImpl: fetchWith({ script: "evil()" }),
      doc,
    });
    expect(r).toMatchObject({
      status: "unverified",
      reason: "entry bundle digest mismatch",
    });
  });

  it("rejects a manifest not matching the Rekor entry", async () => {
    const tampered = `${hex("evil()")}  assets/index-abc.js\n`;
    const r = await verifyProvenance({
      fetchImpl: fetchWith({ digests: tampered, script: "evil()" }),
      doc,
    });
    expect(r.reason).toBe("Rekor entry does not match digest manifest");
  });
});
