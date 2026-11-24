#!/usr/bin/env node
// #786 — IPv4-literal endpoint check for IPv6-only / NAT64 bearers.
//
// DNS64 only synthesises addresses for hostnames resolved through the
// system resolver. An endpoint written as a dotted-quad (for example
// `http://203.0.113.10:8000`) is never resolved, so it cannot be translated
// by NAT64 and fails with ENETUNREACH/EHOSTUNREACH on an IPv6-only bearer.
//
// Pure helpers plus a small CLI; importing this module has no side effects
// (unlike env_firewall.js). Usage:
//   node scripts/security/endpoint_literals.js .env.example [more files...]
// Exit code 1 when a non-loopback IPv4 literal endpoint is found.

import fs from "node:fs";
import net from "node:net";
import { pathToFileURL } from "node:url";

/** Extract the host from a URL or bare `host[:port]` value, or null. */
export function extractHost(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || v.startsWith("/")) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `tcp://${v}`;
  try {
    const host = new URL(candidate).hostname;
    return host ? host.replace(/^\[|\]$/g, "") : null;
  } catch {
    return null;
  }
}

/**
 * Classify an endpoint host:
 *   "ipv4-literal" | "ipv6-literal" | "loopback" | "hostname" | null
 * Loopback (localhost, 127.0.0.0/8, ::1) is reported separately because it
 * is a dev default, not a NAT64 dependency, but must not ship to devices.
 */
export function classifyEndpoint(value) {
  const host = extractHost(value);
  if (!host) return null;
  if (host.toLowerCase() === "localhost" || host === "::1" || /^127\./.test(host)) return "loopback";
  const family = net.isIP(host);
  if (family === 4) return "ipv4-literal";
  if (family === 6) return "ipv6-literal";
  return "hostname";
}

/** Scan a key/value map; returns [{ key, value, kind }] for non-hostname endpoints. */
export function findLiteralEndpoints(env) {
  const findings = [];
  for (const [key, value] of Object.entries(env)) {
    const kind = classifyEndpoint(value);
    if (kind === "ipv4-literal" || kind === "loopback" || kind === "ipv6-literal") {
      findings.push({ key, value, kind });
    }
  }
  return findings;
}

/** Parse KEY=VALUE lines of a dotenv file (comments and blanks skipped). */
export function parseDotenv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let violations = 0;
  for (const file of process.argv.slice(2)) {
    for (const f of findLiteralEndpoints(parseDotenv(fs.readFileSync(file, "utf8")))) {
      const bad = f.kind === "ipv4-literal";
      if (bad) violations++;
      console[bad ? "error" : "log"](`${bad ? "IPV4-LITERAL" : f.kind} ${f.key} in ${file}`);
    }
  }
  if (violations > 0) process.exit(1);
  console.log("endpoint-literals: OK");
}
