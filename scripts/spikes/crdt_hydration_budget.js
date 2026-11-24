#!/usr/bin/env node
/**
 * Hydration memory and time-to-action budget gate (#933, ISP-066).
 *
 * Replays a 30-day incident history (15,000 operations by default) through the
 * real client protocol, `hydratePaged`, from a cold start. The server side is
 * emulated in-process with the same paging rules as server/routes/sync.ts
 * (src/lib/syncPaging.js), including checksums and the convergence digest.
 *
 * The gate fails (exit 1) when any of these hold, and names the phase:
 *   - peak retained heap, measured after GC, exceeds --budget-mb (default 250)
 *   - time-to-actionable exceeds --tta-ms (default 20000)
 *   - the replay does not apply every operation, or the join receipt does not
 *     verify against the server digest (a convergence failure)
 *
 * This is a Node proxy for a memory-limited browser. It bounds the client's
 * data structures and protocol behaviour, not the browser's own overhead. A
 * browser-level run is a follow-up.
 *
 * Usage:
 *   node --expose-gc --max-old-space-size=512 scripts/spikes/crdt_hydration_budget.js
 *     [--ops 15000] [--budget-mb 250] [--tta-ms 20000] [--page-size 500]
 *     [--inject-phase deltas --inject-heap-mb 300]   deliberate regression check
 *     [--out artifacts/crdt-hydration-budget.json]
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { hydratePaged } from "../../src/services/crdtSync.js";
import { opIdentity, stateDigest, sumVector } from "../../src/lib/syncIntegrity.js";
import { compareForPaging, cutPage } from "../../src/lib/syncPaging.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const OPS = Number(arg("ops", 15000));
const BUDGET_MB = Number(arg("budget-mb", 250));
const TTA_MS = Number(arg("tta-ms", 20000));
const PAGE_SIZE = Number(arg("page-size", 500));
const INJECT_PHASE = arg("inject-phase", null);
const INJECT_HEAP_MB = Number(arg("inject-heap-mb", 0));
const OUT = arg("out", null);

const HISTORY_MS = 30 * 24 * 60 * 60 * 1000;
const ACTORS = 30;
const INCIDENTS = 500;
const MB = 1024 * 1024;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// ── Deterministic 30-day history ─────────────────────────────────────────────

function buildHistory() {
  const start = Date.UTC(2026, 0, 1);
  const counters = new Map();
  const history = [];
  for (let i = 0; i < OPS; i++) {
    const actor = `responder-${i % ACTORS}`;
    const counter = (counters.get(actor) ?? 0) + 1;
    counters.set(actor, counter);
    history.push({
      key: `incident-${i % INCIDENTS}`,
      value: {
        status: ["open", "assigned", "resolved"][i % 3],
        lat: 6.5 + (i % 1000) / 10000,
        lng: 3.3 + (i % 997) / 10000,
      },
      deleted: false,
      actor,
      counter,
      timestamp: start + Math.floor((i * HISTORY_MS) / OPS),
    });
  }
  return history;
}

// ── Emulated server (mirrors server/routes/sync.ts) ───────────────────────────

const HISTORY = buildHistory();
const ORACLE_CLOCK = {};
for (const op of HISTORY) ORACLE_CLOCK[op.actor] = Math.max(ORACLE_CLOCK[op.actor] ?? 0, op.counter);
const ORACLE_VALUES = new Map();
for (const op of HISTORY) {
  const current = ORACLE_VALUES.get(op.key);
  if (!current || op.timestamp >= current.timestamp) ORACLE_VALUES.set(op.key, op);
}
const EXPECTED_DIGEST = {
  highwater: sumVector(ORACLE_CLOCK),
  hash: stateDigest(new Map([...ORACLE_VALUES].map(([k, op]) => [k, op.value]))),
};

function servePage(sinceVector, limit) {
  const ordered = HISTORY.filter((op) => op.counter > (sinceVector[op.actor] ?? 0)).sort(compareForPaging);
  const page = cutPage(ordered, limit);
  const next_vector = { ...sinceVector };
  for (const op of page) next_vector[op.actor] = Math.max(next_vector[op.actor] ?? 0, op.counter);
  return {
    operations: page,
    deltas: page,
    next_vector,
    has_more: page.length < ordered.length,
    total_remaining: ordered.length - page.length,
    checksum: sha256(JSON.stringify(page)),
  };
}

// ── Client document with retained operations (like LwwElementSet) ────────────

class BudgetDoc {
  constructor() {
    this.clock = {};
    this.operations = new Map();
    this.entries = new Map();
  }
  merge(ops) {
    for (const op of ops) {
      const id = opIdentity(op);
      if (this.operations.has(id)) continue;
      this.operations.set(id, op);
      this.clock[op.actor] = Math.max(this.clock[op.actor] ?? 0, op.counter);
      const current = this.entries.get(op.key);
      if (!current || op.timestamp >= current.timestamp) this.entries.set(op.key, op);
    }
  }
  values() {
    return [...this.entries.values()].filter((op) => !op.deleted).map((op) => [op.key, op.value]);
  }
}

// ── Heap sampling by phase ───────────────────────────────────────────────────

const phases = new Map();
let currentPhase = "init";
const ballast = [];

function retainedHeapMB() {
  globalThis.gc?.();
  return process.memoryUsage().heapUsed / MB;
}

function samplePhase(label = currentPhase) {
  const mb = retainedHeapMB();
  const record = phases.get(label) ?? { phase: label, peakHeapMB: 0, startedAt: performance.now(), endedAt: null };
  record.peakHeapMB = Math.max(record.peakHeapMB, mb);
  phases.set(label, record);
  return mb;
}

function enterPhase(phase) {
  const previous = phases.get(currentPhase);
  if (previous && previous.endedAt === null) previous.endedAt = performance.now();
  currentPhase = phase;
  samplePhase(phase);
  if (INJECT_PHASE === phase && INJECT_HEAP_MB > 0 && ballast.length === 0) {
    // Deliberate regression: retain about INJECT_HEAP_MB of live objects in this
    // phase. Objects are used because V8 does not count repeated-string padding
    // toward heapUsed.
    const start = process.memoryUsage().heapUsed;
    while ((process.memoryUsage().heapUsed - start) / MB < INJECT_HEAP_MB) {
      for (let i = 0; i < 20000; i++) {
        ballast.push({ i: ballast.length, s: `row-${ballast.length}-${"abcdefghij".repeat(8)}` });
      }
    }
    samplePhase(phase);
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  if (typeof globalThis.gc !== "function") {
    throw new Error("run with --expose-gc so the heap is measured after GC, not with garbage included");
  }
  const doc = new BudgetDoc();
  const fetcher = async (url) => {
    const parsed = new URL(url, "http://budget.local");
    const path = parsed.pathname;
    const json = (payload) => ({
      ok: true,
      status: 200,
      // Round-trip through JSON so each page costs what a real response would.
      json: async () => JSON.parse(JSON.stringify(payload)),
    });
    if (path === "/api/dispatch") {
      return json(Array.from({ length: 20 }, (_, i) => ({ id: `disp-${i}`, status: "open" })));
    }
    if (path === "/api/sync/snapshot") {
      // Cold start with an empty base: the whole history is replayed as deltas.
      return json({ snapshot_id: "snapshot-budget", vector: {}, operations: [], checksum: sha256("[]") });
    }
    if (path === "/api/sync/deltas") {
      const since = JSON.parse(parsed.searchParams.get("since_vector") ?? "{}");
      const limit = Number(parsed.searchParams.get("limit") ?? PAGE_SIZE);
      return json(servePage(since, limit));
    }
    if (path === "/api/sync/digest") return json(EXPECTED_DIGEST);
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const startedAt = performance.now();
  const result = await hydratePaged({
    doc,
    fetcher,
    pageSize: PAGE_SIZE,
    onProgress: (event) => {
      // Sample on every event, not only on phase changes: the heap grows page by
      // page during the delta replay, so its peak sits between phase boundaries.
      if (event.phase && event.phase !== currentPhase) enterPhase(event.phase);
      else samplePhase();
    },
  });
  const elapsedMs = performance.now() - startedAt;
  samplePhase("complete");

  const breaches = [];
  const peak = [...phases.values()].reduce((a, b) => (b.peakHeapMB > a.peakHeapMB ? b : a));
  if (peak.peakHeapMB > BUDGET_MB) {
    breaches.push({
      metric: "peak_heap_mb",
      phase: peak.phase,
      value: round(peak.peakHeapMB),
      limit: BUDGET_MB,
      message: `heap budget exceeded in phase "${peak.phase}": ${round(peak.peakHeapMB)} MB > ${BUDGET_MB} MB`,
    });
  }
  const tta = result.timeToActionableMs;
  if (tta === null || tta > TTA_MS) {
    breaches.push({
      metric: "time_to_actionable_ms",
      phase: "actionable",
      value: tta === null ? null : round(tta),
      limit: TTA_MS,
      message: `time-to-actionable ${tta === null ? "unavailable" : `${round(tta)} ms`} exceeds ${TTA_MS} ms in phase "actionable"`,
    });
  }
  if (result.totalOps !== OPS) {
    breaches.push({
      metric: "replay_incomplete",
      phase: "deltas",
      value: result.totalOps,
      limit: OPS,
      message: `replay applied ${result.totalOps} of ${OPS} operations in phase "deltas"`,
    });
  }
  if (!result.receiptVerification?.complete) {
    breaches.push({
      metric: "convergence",
      phase: "join_receipt",
      value: result.receiptVerification?.reason ?? "no_verification",
      limit: "complete",
      message: `join receipt did not verify in phase "join_receipt": ${result.receiptVerification?.reason ?? "no verification"}`,
    });
  }

  const report = {
    scenario: { ops: OPS, actors: ACTORS, incidents: INCIDENTS, pageSize: PAGE_SIZE, historyDays: 30 },
    budget: { heapMB: BUDGET_MB, timeToActionableMs: TTA_MS },
    injected: INJECT_PHASE ? { phase: INJECT_PHASE, heapMB: INJECT_HEAP_MB } : null,
    result: {
      pagesApplied: result.pagesApplied,
      totalOps: result.totalOps,
      duplicatesSkipped: result.duplicatesSkipped,
      reworkRatio: round(result.reworkRatio, 4),
      timeToActionableMs: tta === null ? null : round(tta),
      elapsedMs: round(elapsedMs),
      receiptVerified: Boolean(result.receiptVerification?.complete),
    },
    peak: { phase: peak.phase, heapMB: round(peak.peakHeapMB) },
    phases: [...phases.values()].map((p) => ({
      phase: p.phase,
      peakHeapMB: round(p.peakHeapMB),
      durationMs: p.endedAt === null ? null : round(p.endedAt - p.startedAt),
    })),
    breaches,
    pass: breaches.length === 0,
  };

  console.log(JSON.stringify(report, null, 2));
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
  }
  if (!report.pass) {
    for (const b of breaches) console.error(`[crdt-budget] FAIL ${b.message}`);
    process.exitCode = 1;
  } else {
    console.log(`[crdt-budget] PASS peak ${round(peak.peakHeapMB)} MB (budget ${BUDGET_MB} MB), time-to-actionable ${round(tta)} ms`);
  }
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

main().catch((err) => {
  console.error("[crdt-budget] run failed:", err);
  process.exitCode = 1;
});
