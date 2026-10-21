#!/usr/bin/env node
// #794 — one-command incident tape builder.
//
//   node scripts/build-incident-tape.js \
//     --ring ring-a.json --ring ring-b.json --otel traces.json \
//     --ledger events.json --log server.log.json \
//     --offsets offsets.json --out tape.json [--include-raw]
//
// offsets.json: { "ring:<device>": { "offsetMs": -120000, "confidenceMs": 300 }, "log": {...} }
// Output is PII-scrubbed by default; --include-raw is break-glass and is
// logged to stderr for audit.
import fs from "node:fs";
import { buildIncidentTape } from "../server/lib/incidentTape.js";

const args = process.argv.slice(2);
const inputs = { ring: [], otel: [], ledger: [], log: [] };
let offsets = {};
let out = null;
let includeRaw = false;

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
  else {
    console.error(`unknown flag: ${flag}`);
    process.exit(2);
  }
}

if (includeRaw) console.error(`[incident-tape] BREAK-GLASS raw tape requested by ${process.env.USER || "unknown"} at ${new Date().toISOString()}`);

const started = Date.now();
const tape = buildIncidentTape(inputs, offsets, { includeRaw });
const json = JSON.stringify({ generatedAt: new Date().toISOString(), scrubbed: !includeRaw, events: tape }, null, 2);
if (out) fs.writeFileSync(out, json);
else process.stdout.write(json + "\n");
console.error(`[incident-tape] merged ${tape.length} events in ${Date.now() - started}ms`);
