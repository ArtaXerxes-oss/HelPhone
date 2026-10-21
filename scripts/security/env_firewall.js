#!/usr/bin/env node
// #626 — Build pipeline env/secret firewall.
//
// Three jobs in one zero-dependency module:
//   1. process.env firewall: a Proxy hides sensitive keys (Stellar secret
//      seeds, API tokens, ...) from third-party build scripts while keeping
//      public `VITE_*` / build vars visible. Access attempts are logged.
//   2. Network monitor: wraps net/tls/http/https socket creation. Default
//      is monitor-only (log); set HELPHONE_FIREWALL_BLOCK_NETWORK=1 (used
//      by `npm run build:secure`) to deny outbound connections during
//      non-network build phases.
//   3. Bundle audit: `auditBundle(dir)` scans emitted static assets for
//      leaked secret values / key patterns. Also exposed as a Vite plugin
//      (`envFirewallVitePlugin`) wired into vite.config.ts, plus CLI:
//        node scripts/security/env_firewall.js --audit dist
//        node scripts/security/env_firewall.js --exec <cmd...>
//
// Importing this module installs the env Proxy + network monitor (safe
// defaults: no blocking). Blocking only engages via env flag or --exec.

import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SENSITIVE_KEY_RE =
  /SECRET|PRIVATE|TOKEN|MNEMONIC|SEED|PASSPHRASE|PASSWORD|API[_-]?KEY|AUTH[_-]?TOKEN|STELLAR[_-]?SECRET|SUPABASE.*(KEY|SECRET)|MAPBOX.*TOKEN/i;
const PUBLIC_PREFIX_RE = /^(VITE_|NODE_ENV|PATH|HOME|HELPHONE_FIREWALL_)/;
const SECRET_VALUE_PATTERNS = [
  { name: "stellar-secret-seed", re: /\bS[A-Z2-7]{55}\b/g },
  {
    name: "supabase-service-key",
    re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
  },
  {
    name: "generic-api-token",
    re: /\b(sk-live|ghp_|gho_|xox[bpas]-)[A-Za-z0-9_-]{10,}/g,
  },
];

// ISP-130 — PII patterns for incident-bundle scrubbing. A bundle concentrates
// every leak source at once; "scrubbed" must mean GDPR-safe for volunteer
// sharing, not just API-key-free.
const PII_VALUE_PATTERNS = [
  {
    name: "e164-phone",
    re: /\+\d[\d\s\-().]{7,17}\d/g,
    replacement: "[REDACTED-PHONE]",
  },
  {
    name: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[REDACTED-EMAIL]",
  },
  {
    name: "full-precision-coords",
    re: /\b-?\d{1,3}\.\d{5,}\s*,\s*-?\d{1,3}\.\d{5,}\b/g,
    replacement: "[REDACTED-COORDS]",
  },
  {
    name: "free-text-notes",
    re: /"?\b(notes|comment|memo|description|message)"?\s*[:=]\s*"([^"]{4,})"/gi,
    replacement: '"$1":"[REDACTED-NOTE]"',
  },
];

export { PII_VALUE_PATTERNS, SECRET_VALUE_PATTERNS };

// #792 — request PII (not secrets). Used by `--scan` on logs, trace exports
// and contract-state snapshots; not applied to the JS bundle, where source
// coordinates/phone formats would false-positive.
export const PII_PATTERNS = [
  { name: "e164-phone", re: /\+[1-9]\d{7,14}\b/g },
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // Coordinate pairs finer than geohash-7 (>= 4 decimals).
  {
    name: "precise-coordinate",
    re: /"(lat|lng|lon|latitude|longitude)"\s*:\s*"?-?\d{1,3}\.\d{4,}/gi,
  },
  {
    name: "free-text-note",
    re: /"(notes?|memo|description)"\s*:\s*"(?!\[redacted)[^"]{1,}"/gi,
  },
  {
    name: "raw-query-pii",
    re: /[?&](phone|contact|name|lat|lng)=(?!hmac%3A|hmac:)[^&\s"]+/gi,
  },
];

export function scanForPII(text) {
  const findings = [];
  for (const { name, re } of PII_PATTERNS) {
    re.lastIndex = 0;
    const hits = text.match(re);
    if (hits) findings.push({ kind: `pii:${name}`, count: hits.length });
  }
  return findings;
}

// Snapshot before the Proxy below hides sensitive keys (spreads/reads
// through process.env afterwards would no longer see them).
const RAW_ENV = { ...process.env };

export function sensitiveKeys(env = RAW_ENV) {
  return Object.keys(env).filter(
    (k) => SENSITIVE_KEY_RE.test(k) && !PUBLIC_PREFIX_RE.test(k),
  );
}

// ISP-094: Phase-based environment scoping (install must be strictly secret-free)
export function enforcePhase(phase = process.env.HELPHONE_BUILD_PHASE || "install") {
  if (phase === "install") {
    const leaked = sensitiveKeys();
    if (leaked.length > 0) {
      throw new Error(
        `[env-firewall] SECURITY: Install phase must be secret-free. Detected ${leaked.length} sensitive keys: ${leaked.join(", ")}`
      );
    }
  }
}

function installEnvFirewall() {
  if (process.env.__HELPHONE_ENV_FIREWALL__) return; // idempotent
  const realEnv = process.env;
  const warned = new Set();
  const handler = {
    get(t, k) {
      if (
        typeof k === "string" &&
        SENSITIVE_KEY_RE.test(k) &&
        !PUBLIC_PREFIX_RE.test(k) &&
        k in t
      ) {
        if (!warned.has(k)) {
          warned.add(k);
          console.warn(
            `[env-firewall] blocked read of sensitive env key: ${k}`,
          );
        }
        return undefined;
      }
      return Reflect.get(t, k);
    },
    has(t, k) {
      if (
        typeof k === "string" &&
        SENSITIVE_KEY_RE.test(k) &&
        !PUBLIC_PREFIX_RE.test(k)
      )
        return false;
      return Reflect.has(t, k);
    },
    ownKeys(t) {
      return Reflect.ownKeys(t).filter(
        (k) =>
          !(
            typeof k === "string" &&
            SENSITIVE_KEY_RE.test(k) &&
            !PUBLIC_PREFIX_RE.test(k)
          ),
      );
    },
    getOwnPropertyDescriptor(t, k) {
      if (
        typeof k === "string" &&
        SENSITIVE_KEY_RE.test(k) &&
        !PUBLIC_PREFIX_RE.test(k)
      )
        return undefined;
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
  };
  const proxy = new Proxy(realEnv, handler);
  Object.defineProperty(process, "env", {
    value: proxy,
    writable: true,
    configurable: true,
  });
  process.env.__HELPHONE_ENV_FIREWALL__ = "1";
  // Keep raw values reachable for the audit step + trusted vite plugin only.
  process.env.__HELPHONE_ENV_FIREWALL_KEYS__ = sensitiveKeys(realEnv).join(",");
}

function installNetworkMonitor() {
  if (process.env.__HELPHONE_NET_MONITOR__) return;
  process.env.__HELPHONE_NET_MONITOR__ = "1";
  const blocking = () => process.env.HELPHONE_FIREWALL_BLOCK_NETWORK === "1";
  const guard = (origin, target) => {
    console.warn(`[env-firewall] outbound ${origin} -> ${target}`);
    if (blocking()) {
      const err = new Error(
        `[env-firewall] blocked outbound ${origin} -> ${target} (non-network build phase)`,
      );
      err.code = "EFIREWALL";
      throw err;
    }
  };
  const wrap = (mod, names, origin) => {
    for (const name of names) {
      const orig = mod[name];
      if (typeof orig !== "function" || orig.__firewalled__) continue;
      const patched = function (...a) {
        const target = (() => {
          try {
            const o =
              typeof a[0] === "object" ? a[0] : { host: a[0], port: a[1] };
            return `${o.host || o.hostname || o.path || "?"}:${o.port || ""}`;
          } catch {
            return "?";
          }
        })();
        guard(origin, target);
        return orig.apply(this, a);
      };
      patched.__firewalled__ = true;
      mod[name] = patched;
    }
  };
  wrap(net, ["connect", "createConnection"], "net.connect");
  wrap(tls, ["connect"], "tls.connect");
  wrap(http, ["request", "get"], "http.request");
  wrap(https, ["request", "get"], "https.request");
  const origLookup = dns.lookup;
  dns.lookup = function (hostname, ...rest) {
    console.warn(`[env-firewall] dns.lookup -> ${hostname}`);
    if (blocking())
      throw Object.assign(
        new Error(`[env-firewall] blocked dns.lookup -> ${hostname}`),
        { code: "EFIREWALL" },
      );
    return origLookup.call(this, hostname, ...rest);
  };
}

export function auditBundle(dir = "dist", extraValues = []) {
  const root = path.resolve(dir);
  const secretValues = new Map(); // value -> key name
  for (const k of sensitiveKeys(RAW_ENV)) {
    const v = RAW_ENV[k] ?? "";
    if (v && v.length >= 8) secretValues.set(v, k);
  }
  for (const v of extraValues)
    if (v && v.length >= 8) secretValues.set(v, "extra");
  const findings = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs|html|css|json|txt|svg)$/.test(e.name)) {
        const text = fs.readFileSync(p, "utf8");
        for (const [val, key] of secretValues) {
          if (text.includes(val))
            findings.push({
              file: path.relative(root, p),
              kind: `leaked-value-of:${key}`,
            });
        }
        for (const { name, re } of SECRET_VALUE_PATTERNS) {
          re.lastIndex = 0;
          if (re.test(text))
            findings.push({
              file: path.relative(root, p),
              kind: `pattern:${name}`,
            });
        }
        // PII patterns are intentionally NOT part of the dist audit: free-text
        // rules (message=..., notes=...) false-positive on minified app code.
        // PII scrubbing applies to incident bundles via scrubText/scanForPii.
      }
    }
  };
  if (!fs.existsSync(root)) {
    console.log(
      `[env-firewall] audit skipped: ${dir} does not exist (run after build)`,
    );
    return [];
  }
  walk(root);
  return findings;
}

// ISP-130 — scrubbing engine reused by the incident-bundle generator.
const REDACTION_VERSION = "1";

export function redactionVersion() {
  return REDACTION_VERSION;
}

/** Scrub secrets + PII from free text. Returns { text, hits: [{name,count}] }. */
export function scrubText(
  text,
  { includeSecrets = true, includePii = true } = {},
) {
  const source = String(text ?? "");
  let out = source;
  const hits = [];
  const patterns = [];
  if (includeSecrets)
    patterns.push(
      ...SECRET_VALUE_PATTERNS.map((p) => ({
        ...p,
        replacement: "[REDACTED-SECRET]",
      })),
    );
  if (includePii) patterns.push(...PII_VALUE_PATTERNS);
  for (const { name, re, replacement } of patterns) {
    re.lastIndex = 0;
    let count = 0;
    out = out.replace(re, (...args) => {
      count++;
      if (replacement) {
        // Support capture-group-preserving replacements (e.g. notes field).
        return replacement.replace(/\$(\d)/g, (_, n) => args[Number(n)] ?? "");
      }
      return "[REDACTED]";
    });
    if (count > 0) hits.push({ name, count });
  }
  // Literal env secret values.
  for (const [val, key] of (() => {
    const m = new Map();
    for (const k of sensitiveKeys(RAW_ENV)) {
      const v = RAW_ENV[k] ?? "";
      if (v && v.length >= 8) m.set(v, k);
    }
    return m;
  })()) {
    if (out.includes(val)) {
      out = out.split(val).join(`[REDACTED-ENV:${key}]`);
      hits.push({ name: `env-value:${key}`, count: 1 });
    }
  }
  return { text: out, hits };
}

/** Deep-scrub a JSON-compatible object (structural, preserves shape). */
export function scrubObject(obj, opts = {}) {
  const SENSITIVE_KEY_RE =
    /phone|email|notes|comment|memo|description|message|address|contact|name|lat|lng|lon|wallet/i;
  const seen = new WeakSet();
  const walk = (value, key = "") => {
    if (typeof value === "string") {
      if (SENSITIVE_KEY_RE.test(key)) {
        return opts.includePii === false ? value : "[REDACTED-PII]";
      }
      return scrubText(value, opts).text;
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (value && typeof value === "object") {
      if (seen.has(value)) return null;
      seen.add(value);
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = walk(v, k);
      }
      return out;
    }
    return value;
  };
  return walk(obj);
}

/** Report every PII/secret hit in a file — used by `--scan` and bundle gates. */
export function scanForPii(text) {
  const findings = [];
  for (const { name, re } of [
    ...SECRET_VALUE_PATTERNS,
    ...PII_VALUE_PATTERNS,
  ]) {
    re.lastIndex = 0;
    const matches = String(text ?? "").match(re) || [];
    // Ignore our own redaction tokens so scrubbed output passes the gate.
    const real = matches.filter((m) => !m.includes("[REDACTED"));
    if (real.length > 0) {
      findings.push({ name, count: real.length, sample: real[0].slice(0, 48) });
    }
  }
  return findings;
}

// Vite plugin: fails `vite build` if static output contains secrets.
export function envFirewallVitePlugin(options = {}) {
  const dir = options.dir || "dist";
  return {
    name: "helphone-env-firewall-audit",
    closeBundle() {
      const findings = auditBundle(dir, options.extraValues || []);
      if (findings.length > 0) {
        for (const f of findings)
          console.error(`[env-firewall] LEAK ${f.kind} in ${f.file}`);
        throw new Error(
          `[env-firewall] secret leak detected in ${dir} (${findings.length} finding(s))`,
        );
      }
      console.log("[env-firewall] bundle audit: no secret leaks");
    },
  };
}

installEnvFirewall();
installNetworkMonitor();

// --- CLI ---------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv[0] === "--audit") {
  const findings = auditBundle(argv[1] || "dist");
  for (const f of findings) console.error(`LEAK ${f.kind} in ${f.file}`);
  if (findings.length > 0) process.exit(1);
  console.log("env-firewall: bundle audit OK");
} else if (argv[0] === "--scan") {
  // node scripts/security/env_firewall.js --scan <file...>
  // Scans each file for secrets + PII (ISP-130 scanForPii with samples, and
  // #792 scanForPII on raw logs/trace exports). Exit 1 when anything is found.
  const targets = argv.slice(1);
  if (targets.length === 0) {
    console.error("env-firewall --scan: provide one or more file paths");
    process.exit(2);
  }
  let total = 0;
  for (const file of targets) {
    if (!fs.existsSync(file)) {
      console.error(`env-firewall --scan: file not found: ${file}`);
      process.exit(2);
    }
    const text = fs.readFileSync(file, "utf8");
    for (const f of scanForPii(text)) {
      total += f.count;
      console.error(
        `PII/SECRET ${f.name} x${f.count} e.g. ${f.sample} in ${file}`,
      );
    }
    for (const f of scanForPII(text)) {
      total += f.count;
      console.error(`PII ${f.kind} x${f.count} in ${file}`);
    }
  }
  if (total > 0) process.exit(1);
  console.log("env-firewall: PII scan OK");
} else if (argv[0] === "--exec") {
  // Spawn the child with the firewall preloaded (NODE_OPTIONS --import)
  // so env reads + network are guarded inside the child too. Secrets stay
  // in the child's RAW_ENV snapshot for the bundle audit, but remain
  // hidden from third-party scripts behind the Proxy.
  const modPath = new URL(import.meta.url).pathname;
  const prevOpts = RAW_ENV.NODE_OPTIONS || "";
  const res = spawnSync(argv[1], argv.slice(2), {
    stdio: "inherit",
    shell: false,
    env: {
      ...RAW_ENV,
      HELPHONE_FIREWALL_BLOCK_NETWORK: "1",
      NODE_OPTIONS: `--import ${modPath} ${prevOpts}`.trim(),
    },
  });
  process.exit(res.status ?? 1);
}
