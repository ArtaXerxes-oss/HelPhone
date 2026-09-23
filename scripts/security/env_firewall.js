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
  { name: "supabase-service-key", re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g },
  { name: "generic-api-token", re: /\b(sk-live|ghp_|gho_|xox[bpas]-)[A-Za-z0-9_-]{10,}/g },
];

// Snapshot before the Proxy below hides sensitive keys (spreads/reads
// through process.env afterwards would no longer see them).
const RAW_ENV = { ...process.env };

export function sensitiveKeys(env = RAW_ENV) {
  return Object.keys(env).filter(
    (k) => SENSITIVE_KEY_RE.test(k) && !PUBLIC_PREFIX_RE.test(k)
  );
}

function installEnvFirewall() {
  if (process.env.__HELPHONE_ENV_FIREWALL__) return; // idempotent
  const realEnv = process.env;
  const warned = new Set();
  const handler = {
    get(t, k) {
      if (typeof k === "string" && SENSITIVE_KEY_RE.test(k) && !PUBLIC_PREFIX_RE.test(k) && k in t) {
        if (!warned.has(k)) {
          warned.add(k);
          console.warn(`[env-firewall] blocked read of sensitive env key: ${k}`);
        }
        return undefined;
      }
      return Reflect.get(t, k);
    },
    has(t, k) {
      if (typeof k === "string" && SENSITIVE_KEY_RE.test(k) && !PUBLIC_PREFIX_RE.test(k)) return false;
      return Reflect.has(t, k);
    },
    ownKeys(t) {
      return Reflect.ownKeys(t).filter(
        (k) => !(typeof k === "string" && SENSITIVE_KEY_RE.test(k) && !PUBLIC_PREFIX_RE.test(k))
      );
    },
    getOwnPropertyDescriptor(t, k) {
      if (typeof k === "string" && SENSITIVE_KEY_RE.test(k) && !PUBLIC_PREFIX_RE.test(k)) return undefined;
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
  };
  const proxy = new Proxy(realEnv, handler);
  Object.defineProperty(process, "env", { value: proxy, writable: true, configurable: true });
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
      const err = new Error(`[env-firewall] blocked outbound ${origin} -> ${target} (non-network build phase)`);
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
            const o = typeof a[0] === "object" ? a[0] : { host: a[0], port: a[1] };
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
    if (blocking()) throw Object.assign(new Error(`[env-firewall] blocked dns.lookup -> ${hostname}`), { code: "EFIREWALL" });
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
  for (const v of extraValues) if (v && v.length >= 8) secretValues.set(v, "extra");
  const findings = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs|html|css|json|txt|svg)$/.test(e.name)) {
        const text = fs.readFileSync(p, "utf8");
        for (const [val, key] of secretValues) {
          if (text.includes(val)) findings.push({ file: path.relative(root, p), kind: `leaked-value-of:${key}` });
        }
        for (const { name, re } of SECRET_VALUE_PATTERNS) {
          re.lastIndex = 0;
          if (re.test(text)) findings.push({ file: path.relative(root, p), kind: `pattern:${name}` });
        }
      }
    }
  };
  if (!fs.existsSync(root)) {
    console.log(`[env-firewall] audit skipped: ${dir} does not exist (run after build)`);
    return [];
  }
  walk(root);
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
        for (const f of findings) console.error(`[env-firewall] LEAK ${f.kind} in ${f.file}`);
        throw new Error(`[env-firewall] secret leak detected in ${dir} (${findings.length} finding(s))`);
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
