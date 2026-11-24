#!/usr/bin/env node
// #794 / #951 — one-command incident tape builder with maintainer signing & expiry.
//
//   node scripts/build-incident-tape.js \
//     --ring ring-a.json --ring ring-b.json --otel traces.json \
//     --ledger events.json --log server.log.json \
//     --offsets offsets.json --out tape.json \
//     [--tier volunteer-safe|command-internal] [--sign-key key.pem] [--key-id id] [--include-raw]
//
// offsets.json: { "ring:<device>": { "offsetMs": -120000, "confidenceMs": 300 }, "log": {...} }
// Output is PII-scrubbed by default; --include-raw is break-glass and is
// logged to stderr for audit.
import fs from "node:fs";
import {
  buildIncidentTape,
  computeTapeExpiry,
  signIncidentTape,
} from "../server/lib/incidentTape.js";

const args = process.argv.slice(2);
const inputs = { ring: [], otel: [], ledger: [], log: [] };
let offsets = {};
let out = null;
let includeRaw = false;
let tier = null;
let signKeyPath = process.env.HELPHONE_TAPE_SIGNING_KEY_PATH || null;
let keyId = process.env.HELPHONE_TAPE_KEY_ID || "maintainer-default";
let expiresAt = null;

const readJson = (file) => {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(parsed) ? parsed : parsed.events || parsed.rows || parsed.spans || [];
};

for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  const source = flag.replace(/^--/, "");
  if (source in inputs) inputs[source].push(...readJson(args[++i]));
  else if (flag === "--offsets") offsets = JSON.parse(fs.readFileSync(args[++i], "utf8"));
  else if (flag === "--out") out = args[++i];
  else if (flag === "--include-raw") includeRaw = true;
  else if (flag === "--tier") tier = args[++i];
  else if (flag === "--sign-key") signKeyPath = args[++i];
  else if (flag === "--key-id") keyId = args[++i];
  else if (flag === "--expires-at") expiresAt = args[++i];
  else {
    console.error(`unknown flag: ${flag}`);
    process.exit(2);
  }
}

if (includeRaw) console.error(`[incident-tape] BREAK-GLASS raw tape requested by ${process.env.USER || "unknown"} at ${new Date().toISOString()}`);

const resolvedTier = tier || (includeRaw ? "command-internal" : "volunteer-safe");
const generatedAt = new Date().toISOString();
const resolvedExpiresAt = expiresAt || computeTapeExpiry(generatedAt, resolvedTier);

const started = Date.now();
const events = buildIncidentTape(inputs, offsets, { includeRaw });
let doc = {
  generatedAt,
  scrubbed: !includeRaw,
  tier: resolvedTier,
  expiresAt: resolvedExpiresAt,
  events,
};

const privateKeyPem = signKeyPath
  ? fs.readFileSync(signKeyPath, "utf8")
  : process.env.HELPHONE_TAPE_SIGNING_KEY || null;
if (privateKeyPem) {
  doc = signIncidentTape(doc, privateKeyPem, { keyId, tier: resolvedTier });
}

const json = JSON.stringify(doc, null, 2);
if (out) fs.writeFileSync(out, json);
else process.stdout.write(json + "\n");
console.error(`[incident-tape] merged ${events.length} events in ${Date.now() - started}ms (tier=${resolvedTier}, signed=${Boolean(privateKeyPem)})`);
