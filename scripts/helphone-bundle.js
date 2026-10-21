#!/usr/bin/env node
/**
 * helphone-bundle — one-command incident-bundle generator (ISP-130).
 *
 *   node scripts/helphone-bundle.js collect --since 2h --tier volunteer-safe --out bundle.tgz
 *   node scripts/helphone-bundle.js verify bundle.tgz
 *
 * Produces a manifest-led .tgz (pure-JS tar+gzip, zero deps):
 *   manifest.json          collector, window, git SHAs, flag versions, per-file
 *                          sha256 + redaction version + source, expiry
 *   server-logs/           morgan/structured log slice (scrubbed)
 *   config/                env allowlist + feature-flag snapshot + build defines
 *   build/                 SBOM: lock hashes, chunk hashes, container digest
 *   ledger/                contract-state export window (when available)
 *   metrics/               load-test baseline reference
 *   client/                ring/crash slices (when the device exports them)
 *   audit-log.json         break-glass record for command-internal tier
 *
 * Tiers:
 *   volunteer-safe      (default) secrets + PII scrubbed — safe to share
 *   command-internal    full-fidelity PII (secrets still redacted), requires
 *                       --break-glass, writes audit log, 7-day expiry
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  redactionVersion,
  scrubText,
  scanForPii,
} from "./security/env_firewall.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TIERS = {
  "volunteer-safe": {
    scrubPii: true,
    expiryDays: 30,
    requiresBreakGlass: false,
  },
  "command-internal": {
    scrubPii: false,
    expiryDays: 7,
    requiresBreakGlass: true,
  },
};

// ── minimal ustar tar + gzip (zero-dependency) ──────────────────────────────

function tarPack(entries) {
  const chunks = [];
  for (const { name, data } of entries) {
    const buf = Buffer.from(data);
    const header = Buffer.alloc(512);
    header.write(name.slice(0, 99), 0, "utf8");
    header.write("000644\0", 100);
    header.write("000000\0", 108);
    header.write("000000\0", 116);
    header.write(buf.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write(
      Math.floor(Date.now() / 1000)
        .toString(8)
        .padStart(11, "0") + "\0",
      136,
    );
    header.write("        ", 148); // checksum placeholder
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    chunks.push(header, buf, Buffer.alloc((512 - (buf.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function tarUnpack(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (!name) break;
    const size = parseInt(
      header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim() ||
        "0",
      8,
    );
    const data = buffer.subarray(offset + 512, offset + 512 + size);
    entries.push({ name, data });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

// ── collection helpers ──────────────────────────────────────────────────────

function parseSince(since) {
  const m = /^(\d+)([smhd])$/.exec(String(since || "2h"));
  if (!m) return 2 * 3600 * 1000;
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
  return n * unit;
}

function gitInfo() {
  const run = (cmd) => {
    try {
      return execSync(cmd, {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  return {
    commit: run("git rev-parse HEAD"),
    branch: run("git rev-parse --abbrev-ref HEAD"),
    dirty: run("git status --porcelain") ? true : false,
    remote: run("git config --get remote.origin.url"),
  };
}

function safeEnvAllowlist() {
  const allow = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (
      /SECRET|PRIVATE|TOKEN|MNEMONIC|SEED|PASSPHRASE|PASSWORD|API[_-]?KEY|AUTH/i.test(
        k,
      )
    )
      continue;
    if (
      /^(VITE_|NODE_ENV|npm_|CI|CONTAINER_|IMAGE_)/.test(k) ||
      k === "RENDER_SERVICE_ID"
    ) {
      allow[k] = scrubText(String(v ?? "")).text;
    }
  }
  return allow;
}

function clientFlagSnapshot() {
  // Mirrors src/lib/field/flags.js defaults; live values live per-device.
  const defaults = {
    radioBridge: { enabled: true, version: 1 },
    nfcCheckIn: { enabled: true, version: 1 },
    hardwareSos: { enabled: true, version: 1 },
    ruggedMode: { enabled: true, version: 1 },
  };
  try {
    const live = fs.readFileSync(
      path.join(ROOT, "src/lib/field/flags.js"),
      "utf8",
    );
    const versions = [...live.matchAll(/version:\s*(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    if (versions.length >= Object.keys(defaults).length) {
      Object.keys(defaults).forEach((k, i) => {
        if (versions[i] != null) defaults[k].version = versions[i];
      });
    }
  } catch {
    // best-effort — surface failures are non-fatal here
  }
  return defaults;
}

function buildSbom() {
  const sbom = {
    files: {},
    chunks: {},
    containerDigest:
      process.env.CONTAINER_DIGEST || process.env.IMAGE_DIGEST || null,
  };
  const lockPath = path.join(ROOT, "package-lock.json");
  if (fs.existsSync(lockPath)) {
    const data = fs.readFileSync(lockPath);
    sbom.files["package-lock.json"] = {
      sha256: sha256(data),
      bytes: data.length,
    };
  }
  const pkgPath = path.join(ROOT, "package.json");
  if (fs.existsSync(pkgPath)) {
    const data = fs.readFileSync(pkgPath);
    sbom.files["package.json"] = { sha256: sha256(data), bytes: data.length };
  }
  const distDir = path.join(ROOT, "dist/assets");
  if (fs.existsSync(distDir)) {
    for (const f of fs.readdirSync(distDir).slice(0, 200)) {
      const p = path.join(distDir, f);
      if (!fs.statSync(p).isFile()) continue;
      const data = fs.readFileSync(p);
      sbom.chunks[f] = { sha256: sha256(data), bytes: data.length };
    }
  }
  const wasmDir = path.join(ROOT, "src/wasm");
  if (fs.existsSync(wasmDir)) {
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
        else if (e.name.endsWith(".wasm")) {
          const data = fs.readFileSync(p);
          sbom.files[`${rel}${e.name}`] = {
            sha256: sha256(data),
            bytes: data.length,
          };
        }
      }
    };
    walk(wasmDir, "wasm/");
  }
  return sbom;
}

function logSlice({ logFile, sinceMs }) {
  if (!logFile) return null;
  const abs = path.isAbsolute(logFile) ? logFile : path.join(ROOT, logFile);
  if (!fs.existsSync(abs)) return null;
  const cutoff = Date.now() - sinceMs;
  const lines = fs.readFileSync(abs, "utf8").split("\n");
  const kept = lines.filter((line) => {
    const ts = line.match(
      /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/,
    );
    if (!ts) return true; // keep unparseable lines; scrubber runs anyway
    const t = Date.parse(ts[0].replace(" ", "T"));
    return Number.isNaN(t) || t >= cutoff;
  });
  return kept.join("\n");
}

// ── collect ─────────────────────────────────────────────────────────────────

export function collectBundle({
  since = "2h",
  tier = "volunteer-safe",
  out = "helphone-bundle.tgz",
  breakGlass = false,
  logFile = null,
  dispatch = false,
  extraFiles = {},
} = {}) {
  const tierCfg = TIERS[tier];
  if (!tierCfg) throw new Error(`unknown tier: ${tier}`);
  if (tierCfg.requiresBreakGlass && !breakGlass) {
    throw new Error(
      "command-internal tier requires --break-glass (full-fidelity PII handling)",
    );
  }
  const sinceMs = parseSince(since);
  const now = Date.now();
  const window_ = {
    since,
    from: new Date(now - sinceMs).toISOString(),
    to: new Date(now).toISOString(),
  };
  const scrubOpts = { includePii: tierCfg.scrubPii, includeSecrets: true };

  const files = [];
  const push = (name, content, source) => {
    const buf = Buffer.from(content);
    files.push({ name, data: buf, source });
  };

  // server logs
  const logs = logSlice({ logFile, sinceMs });
  push(
    "server-logs/slice.txt",
    logs
      ? scrubText(logs, scrubOpts).text
      : "# No --log-file supplied.\n# Capture morgan/structured stdout for the incident window and re-run with --log-file.\n",
    "server/middleware/logger.ts",
  );

  // config
  push(
    "config/env-allowlist.json",
    JSON.stringify(safeEnvAllowlist(), null, 2),
    "env",
  );
  push(
    "config/feature-flags.json",
    JSON.stringify(clientFlagSnapshot(), null, 2),
    "src/lib/field/flags.js",
  );
  const viteConfig = fs.existsSync(path.join(ROOT, "vite.config.ts"))
    ? fs.readFileSync(path.join(ROOT, "vite.config.ts"), "utf8")
    : "";
  push(
    "config/build-defines.json",
    JSON.stringify(
      {
        viteConfigSha256: viteConfig ? sha256(Buffer.from(viteConfig)) : null,
        coop: "same-origin",
        coep: "credentialless",
        pwaDisplay: "standalone",
        nodeVersion: process.version,
      },
      null,
      2,
    ),
    "vite.config.ts",
  );

  // build SBOM
  push("build/sbom.json", JSON.stringify(buildSbom(), null, 2), "build");

  // ledger + metrics + client placeholders (collected when artifacts exist)
  const contractScript = path.join(ROOT, "scripts/export-contract-state.sh");
  push(
    "ledger/contract-state.txt",
    fs.existsSync(contractScript)
      ? "# run scripts/export-contract-state.sh --window to populate\n"
      : "# contract export not available in this checkout\n",
    "scripts/export-contract-state.sh",
  );
  push(
    "metrics/load-baseline.txt",
    fs.existsSync(path.join(ROOT, "server/tests/load.js"))
      ? fs
          .readFileSync(path.join(ROOT, "server/tests/load.js"), "utf8")
          .split("\n")
          .slice(0, 40)
          .join("\n")
      : "# load baseline not available\n",
    "server/tests/load.js",
  );
  push(
    "client/README.txt",
    "# Client ring/crash slices: export from the device via TelemetryLab-equivalent\n# (ringBuffer/crashRecovery) and re-run with --client-slice <file>.\n",
    "src/lib",
  );

  // operator-supplied extras
  for (const [name, content] of Object.entries(extraFiles)) {
    push(name, scrubText(String(content), scrubOpts).text, "operator");
  }

  // scrub every text file we produced
  for (const f of files) {
    if (/\.(json|txt|log|md)$/.test(f.name)) {
      f.data = Buffer.from(scrubText(f.data.toString("utf8"), scrubOpts).text);
    }
    // Hard gate: volunteer-safe bundles must contain zero PII/secret hits.
    if (tierCfg.scrubPii) {
      const hits = scanForPii(f.data.toString("utf8"));
      if (hits.length > 0) {
        throw new Error(
          `scrub verification failed for ${f.name}: ${hits.map((h) => h.name).join(", ")}`,
        );
      }
    }
  }

  // manifest with per-file hashes
  const manifest = {
    format: "helphone-bundle/1",
    collector: `${os.userInfo().username}@${os.hostname()}`,
    collectedAt: new Date(now).toISOString(),
    window: window_,
    tier,
    dispatch: !!dispatch,
    git: gitInfo(),
    flagVersions: clientFlagSnapshot(),
    redactionVersion: redactionVersion(),
    expiresAt: new Date(now + tierCfg.expiryDays * 86400000).toISOString(),
    files: files.map((f) => ({
      path: f.name,
      sha256: sha256(f.data),
      bytes: f.data.length,
      redaction: tierCfg.scrubPii
        ? `scrub-v${redactionVersion()}`
        : "secrets-only",
      source: f.source,
    })),
  };
  if (tierCfg.requiresBreakGlass) {
    push(
      "audit-log.json",
      JSON.stringify(
        {
          actor: manifest.collector,
          at: manifest.collectedAt,
          tier,
          reason: "break-glass incident response",
          expiresAt: manifest.expiresAt,
        },
        null,
        2,
      ),
      "break-glass",
    );
    manifest.files.push({
      path: "audit-log.json",
      sha256: sha256(files[files.length - 1].data),
      bytes: files[files.length - 1].data.length,
      redaction: "none",
      source: "break-glass",
    });
  }

  const allEntries = [
    {
      name: "manifest.json",
      data: Buffer.from(JSON.stringify(manifest, null, 2)),
    },
    ...files.map((f) => ({ name: f.name, data: f.data })),
  ];
  const tgz = zlib.gzipSync(tarPack(allEntries));
  const outAbs = path.isAbsolute(out) ? out : path.join(ROOT, out);
  fs.writeFileSync(outAbs, tgz);
  return { manifest, out: outAbs, bytes: tgz.length };
}

export function verifyBundle(tgzPath) {
  const abs = path.isAbsolute(tgzPath)
    ? tgzPath
    : path.join(process.cwd(), tgzPath);
  if (!fs.existsSync(abs)) throw new Error(`bundle not found: ${abs}`);
  const entries = tarUnpack(zlib.gunzipSync(fs.readFileSync(abs)));
  const byName = new Map(entries.map((e) => [e.name, e]));
  const manifestEntry = byName.get("manifest.json");
  if (!manifestEntry) throw new Error("manifest.json missing");
  const manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  const problems = [];
  for (const f of manifest.files || []) {
    const entry = byName.get(f.path);
    if (!entry) {
      problems.push(`missing file: ${f.path}`);
      continue;
    }
    const digest = sha256(entry.data);
    if (digest !== f.sha256) problems.push(`hash mismatch: ${f.path}`);
  }
  return { ok: problems.length === 0, problems, manifest };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function cliMain(argv) {
  const cmd = argv[0] || "collect";
  const flags = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--break-glass") flags.breakGlass = true;
    else if (a === "--dispatch") flags.dispatch = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      flags[key] = argv[++i];
    }
  }
  if (cmd === "collect") {
    const result = collectBundle({
      since: flags.since || "2h",
      tier: flags.tier || "volunteer-safe",
      out: flags.out || "helphone-bundle.tgz",
      breakGlass: !!flags.breakGlass,
      logFile: flags["log-file"] || null,
      dispatch: !!flags.dispatch,
    });
    console.log(
      `helphone-bundle: wrote ${result.out} (${result.bytes} bytes, tier=${result.manifest.tier}, files=${result.manifest.files.length}, expires=${result.manifest.expiresAt})`,
    );
    return 0;
  }
  if (cmd === "verify") {
    const target = argv[1];
    if (!target) {
      console.error("usage: helphone-bundle verify <bundle.tgz>");
      return 2;
    }
    const result = verifyBundle(target);
    if (!result.ok) {
      for (const p of result.problems) console.error(`FAIL ${p}`);
      return 1;
    }
    console.log(
      `helphone-bundle: verify OK (${result.manifest.files.length} files)`,
    );
    return 0;
  }
  console.error("usage: helphone-bundle collect|verify [...]");
  return 2;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(cliMain(process.argv.slice(2)));
}
