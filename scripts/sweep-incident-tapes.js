#!/usr/bin/env node
/**
 * sweep-incident-tapes.js (#951)
 *
 * Scheduled retention sweep for incident tapes with two-phase quarantine
 * (reversible within graceDays) and JSONL audit logging.
 *
 * Usage:
 *   node scripts/sweep-incident-tapes.js --dir artifacts/incident-tapes [--grace-days 7] [--json]
 *   node scripts/sweep-incident-tapes.js --dir artifacts/incident-tapes --restore <filename>
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_GRACE_DAYS,
  restoreQuarantinedTape,
  sweepIncidentTapes,
} from "../server/lib/incidentTape.js";

function parseArgs(argv) {
  const opts = {
    dir: path.resolve(process.cwd(), "artifacts/incident-tapes"),
    graceDays: DEFAULT_GRACE_DAYS,
    restore: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") opts.dir = path.resolve(argv[++i]);
    else if (a === "--grace-days") opts.graceDays = Number(argv[++i]);
    else if (a === "--restore") opts.restore = argv[++i];
    else if (a === "--json") opts.json = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return opts;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.restore) {
    const res = restoreQuarantinedTape({
      tapeDir: opts.dir,
      filename: opts.restore,
    });
    console.log(
      opts.json
        ? JSON.stringify(res, null, 2)
        : `[tape-retention] restored ${opts.restore} -> ${res.restored}`,
    );
  } else {
    const res = sweepIncidentTapes({
      tapeDir: opts.dir,
      graceDays: opts.graceDays,
    });
    console.log(
      opts.json
        ? JSON.stringify(res, null, 2)
        : `[tape-retention] quarantined=${res.quarantined.length} purged=${res.purged.length} retained=${res.retained.length}`,
    );
  }
}
