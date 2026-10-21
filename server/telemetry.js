/**
 * Bounded telemetry receiver.
 *
 * The OTLP exporter used to queue spans in memory with no backpressure. This
 * receiver makes the bound explicit:
 *  - maxQueueSize entries, priority-aware drop-oldest (heartbeat → normal →
 *    critical);
 *  - export failure marks the collector unhealthy and returns Retry-After;
 *  - every drop is reason-coded, and the snapshot is exposed on /metrics.
 */

const PRIORITY_RANK = { heartbeat: 1, normal: 2, critical: 3 };

function priorityOf(span) {
  const value = span?.priority;
  return PRIORITY_RANK[value] ? value : 'normal';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Flatten an OTLP/HTTP JSON payload into the receiver's internal span shape.
 * Accepts both raw `{ spans: [...] }` and OTLP `{ resourceSpans: [...] }`.
 */
export function normalizeSpans(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.spans)) {
    return body.spans.map(normalizeSpan).filter(Boolean);
  }
  const out = [];
  for (const resource of asArray(body.resourceSpans)) {
    for (const scope of asArray(resource?.scopeSpans)) {
      for (const span of asArray(scope?.spans)) {
        const normalized = normalizeSpan(span);
        if (normalized) out.push(normalized);
      }
    }
  }
  return out;
}

function normalizeSpan(span) {
  if (!span || typeof span !== 'object') return null;
  const attributes = Array.isArray(span.attributes)
    ? Object.fromEntries(
        span.attributes
          .filter((attribute) => attribute && typeof attribute.key === 'string')
          .map((attribute) => {
            const value = attribute.value || {};
            return [
              attribute.key,
              value.stringValue ??
                value.doubleValue ??
                value.intValue ??
                value.boolValue ??
                null,
            ];
          }),
      )
    : span.attributes || {};
  return {
    name: String(span.name || 'unknown'),
    priority: priorityOf({ priority: attributes['helphone.priority'] ?? span.priority }),
    kind: String(attributes['helphone.kind'] ?? span.kind ?? 'unknown'),
    ts: Number(span.ts ?? span.startTimeUnixNano / 1e6) || Date.now(),
    attributes,
  };
}

export class TelemetryReceiver {
  constructor(options = {}) {
    this.maxQueueSize = Math.max(1, Math.floor(options.maxQueueSize ?? 1_000));
    this.maxBatchSize = Math.max(1, Math.floor(options.maxBatchSize ?? 100));
    this.flushIntervalMs = Math.max(50, Math.floor(options.flushIntervalMs ?? 1_000));
    this.retryAfterMs = Math.max(100, Math.floor(options.retryAfterMs ?? 2_000));
    this.exporter = options.exporter ?? null;
    this.now = options.now ?? (() => Date.now());

    this.queue = [];
    this.received = 0;
    this.admitted = 0;
    this.rejected = 0;
    this.evicted = 0;
    this.exported = 0;
    this.exportFailed = 0;
    this.dropped = 0;
    this.droppedReasons = {
      overflow_heartbeat: 0,
      overflow_normal: 0,
      overflow_critical: 0,
      export_fail: 0,
      invalid: 0,
    };
    this.healthy = Boolean(this.exporter);
    this.lastError = null;
    this.lastExportAt = null;
    this.unhealthyUntil = 0;
    this.timer = null;
    this.flushing = false;
  }

  /**
   * @returns {{accepted:number,dropped:number,status:number,retryAfter:number|null}}
   */
  ingest(spans) {
    const incoming = asArray(spans).filter(Boolean);
    if (incoming.length === 0) {
      return { accepted: 0, dropped: 0, status: 202, retryAfter: null };
    }

    this.received += incoming.length;
    let accepted = 0;
    let rejected = 0;
    for (const span of incoming) {
      if (!span || typeof span.name !== 'string') {
        this.droppedReasons.invalid++;
        this.dropped++;
        this.rejected++;
        rejected++;
        continue;
      }
      if (!this.admit(span)) {
        rejected++;
      } else {
        accepted++;
      }
    }

    const now = this.now();
    let status = 202;
    let retryAfter = null;

    if (!this.healthy || now < this.unhealthyUntil) {
      status = 503;
      retryAfter = Math.max(1, Math.ceil((this.unhealthyUntil - now) / 1_000)) || 1;
    } else if (this.queue.length >= Math.floor(this.maxQueueSize * 0.9)) {
      status = 429;
      retryAfter = 1;
    }

    return { accepted, dropped: rejected, status, retryAfter };
  }

  admit(span) {
    if (this.queue.length < this.maxQueueSize) {
      this.queue.push(span);
      this.admitted++;
      return true;
    }

    // Find the lowest-priority victim. Never drop a critical span while a
    // heartbeat or normal span remains.
    const victimIndex = this.findVictimIndex();
    if (victimIndex === -1) {
      // Queue is all critical and full: reject the incoming lower/equal span.
      const priority = priorityOf(span);
      this.droppedReasons[`overflow_${priority}`]++;
      this.dropped++;
      this.rejected++;
      return false;
    }

    const victim = this.queue[victimIndex];
    const victimPriority = priorityOf(victim);
    const incomingPriority = priorityOf(span);
    if (PRIORITY_RANK[incomingPriority] < PRIORITY_RANK[victimPriority]) {
      this.droppedReasons[`overflow_${incomingPriority}`]++;
      this.dropped++;
      this.rejected++;
      return false;
    }

    this.queue.splice(victimIndex, 1);
    this.droppedReasons[`overflow_${victimPriority}`]++;
    this.dropped++;
    this.evicted++;
    this.queue.push(span);
    this.admitted++;
    return true;
  }

  findVictimIndex() {
    for (const priority of ['heartbeat', 'normal', 'critical']) {
      const index = this.queue.findIndex((span) => priorityOf(span) === priority);
      if (index !== -1) return index;
    }
    return -1;
  }

  async flush() {
    if (this.flushing) return { status: 'in_flight', count: 0 };
    if (this.queue.length === 0) return { status: 'empty', count: 0 };
    if (!this.exporter) {
      this.markUnhealthy('no exporter configured');
      return { status: 'failed', count: 0, error: this.lastError };
    }

    this.flushing = true;
    const batch = this.queue.splice(0, this.maxBatchSize);
    try {
      await this.exporter.export(batch);
      this.exported += batch.length;
      this.healthy = true;
      this.unhealthyUntil = 0;
      this.lastError = null;
      this.lastExportAt = this.now();
      return { status: 'exported', count: batch.length };
    } catch (error) {
      this.exportFailed += batch.length;
      this.dropped += batch.length;
      this.droppedReasons.export_fail += batch.length;
      this.markUnhealthy(String(error?.message || error), error?.retryAfterMs);
      return { status: 'failed', count: batch.length, error: this.lastError };
    } finally {
      this.flushing = false;
    }
  }

  markUnhealthy(message, retryAfterMs = this.retryAfterMs) {
    this.healthy = false;
    this.lastError = message;
    this.unhealthyUntil = this.now() + Math.max(100, retryAfterMs);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot() {
    return {
      maxQueueSize: this.maxQueueSize,
      maxBatchSize: this.maxBatchSize,
      queueDepth: this.queue.length,
      occupancy: this.queue.length / this.maxQueueSize,
      received: this.received,
      admitted: this.admitted,
      rejected: this.rejected,
      evicted: this.evicted,
      exported: this.exported,
      exportFailed: this.exportFailed,
      dropped: this.dropped,
      droppedReasons: { ...this.droppedReasons },
      conservation: {
        receivedOk: this.received === this.admitted + this.rejected,
        admittedOk:
          this.admitted === this.exported + this.exportFailed + this.evicted + this.queue.length,
        ok:
          this.received === this.admitted + this.rejected &&
          this.admitted === this.exported + this.exportFailed + this.evicted + this.queue.length,
      },
      healthy: this.healthy,
      lastError: this.lastError,
      lastExportAt: this.lastExportAt,
      retryAfterMs: Math.max(0, this.unhealthyUntil - this.now()),
    };
  }
}

/** OTLP/HTTP exporter with a hard timeout. */
export function createOtlpExporter(options = {}) {
  const {
    endpoint = 'http://localhost:4318/v1/traces',
    fetchImpl = globalThis.fetch,
    timeoutMs = 5_000,
    headers = {},
  } = options;

  return {
    async export(spans) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ spans }),
          signal: controller?.signal,
        });
        if (!response.ok) {
          const retryAfter = Number(response.headers?.get?.('retry-after'));
          const error = new Error(`OTLP collector responded ${response.status}`);
          error.retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1_000 : undefined;
          throw error;
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

export default TelemetryReceiver;

import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { scrubText } from "./lib/redact.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

let sdk;

export function initializeTelemetry() {
  if (sdk) return;
  const configuredEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const endpoint = configuredEndpoint
    ? configuredEndpoint.endsWith("/v1/traces")
      ? configuredEndpoint
      : `${configuredEndpoint.replace(/\/$/, "")}/v1/traces`
    : undefined;
  sdk = new NodeSDK({
    instrumentations: [getNodeAutoInstrumentations()],
    ...(endpoint ? { traceExporter: new OTLPTraceExporter({ url: endpoint }) } : {}),
  });
  sdk.start();
}

export function traceIdFromRequest(req) {
  const traceparent = req.get?.("traceparent") || req.headers?.traceparent;
  const match = typeof traceparent === "string" &&
    traceparent.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i);
  return match && !/^0+$/.test(match[1]) ? match[1].toLowerCase() : null;
}

export function telemetryErrorHandler(req, res) {
  const traceId = traceIdFromRequest(req);
  const { message, componentStack, clientTs } = req.body || {};
  const receivedAt = Date.now();
  console.error(JSON.stringify({
    event: "client_error",
    traceId,
    message: typeof message === "string" ? scrubText(message.slice(0, 500)) : "Unknown client error",
    componentStack: typeof componentStack === "string" ? scrubText(componentStack.slice(0, 2000)) : undefined,
    // Event time (client clock) vs ingest time (server clock), kept apart for the incident tape (#794).
    clientTs: Number.isFinite(clientTs) ? clientTs : undefined,
    ingestDelayMs: Number.isFinite(clientTs) ? receivedAt - clientTs : undefined,
    timestamp: new Date(receivedAt).toISOString(),
  }));
  res.status(202).json({ accepted: true, traceId });
}

export async function shutdownTelemetry() {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
}

// ════════════════════════════════════════════════════════════════════════════
// Shared histogram buckets: one `le` set for RUM, synthetic and server-link
// timings, read from perf-budget.json so p95s are directly comparable (#795,
// #796). Falls back to sane defaults if the file is missing in a deploy.
// ════════════════════════════════════════════════════════════════════════════


const here = dirname(fileURLToPath(import.meta.url));

function loadBudget() {
  try {
    return JSON.parse(readFileSync(join(here, "..", "perf-budget.json"), "utf8"));
  } catch {
    return {};
  }
}

export const perfBudget = loadBudget();
export const BUDGET_BUCKETS = Array.isArray(perfBudget.histogramBucketsSeconds)
  ? perfBudget.histogramBucketsSeconds
  : [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

const MAX_SERIES = 2000; // cardinality cap across all telemetry families
const histograms = new Map();
const counters = new Map();
const gauges = new Map();

function seriesKey(name, labels) {
  return `${name}\0${Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join("\0")}`;
}

function totalSeries() {
  return histograms.size + counters.size + gauges.size;
}

export function observeBudgeted(name, labels, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  const key = seriesKey(name, labels);
  let h = histograms.get(key);
  if (!h) {
    if (totalSeries() >= MAX_SERIES) return;
    h = { name, labels, count: 0, sum: 0, buckets: Array(BUDGET_BUCKETS.length).fill(0) };
    histograms.set(key, h);
  }
  h.count += 1;
  h.sum += seconds;
  const i = BUDGET_BUCKETS.findIndex((b) => seconds <= b);
  if (i >= 0) h.buckets[i] += 1;
}

function inc(name, labels, by = 1) {
  const key = seriesKey(name, labels);
  const c = counters.get(key);
  if (c) c.value += by;
  else if (totalSeries() < MAX_SERIES) counters.set(key, { name, labels, value: by });
}

function setGauge(name, labels, value) {
  const key = seriesKey(name, labels);
  if (gauges.has(key) || totalSeries() < MAX_SERIES) gauges.set(key, { name, labels, value });
}

/**
 * Per-link server timer (#795): ws.queue, pg.pool.wait, redis.publish,
 * parser.decode, indexer.lag. Uses budget-aligned buckets so a breach of
 * perf-budget.json `links` is visible as a bucket boundary.
 */
export function observeLink(link, seconds) {
  observeBudgeted("helphone_link_duration_seconds", { link }, seconds);
}

export async function timeLink(link, fn) {
  const started = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    observeLink(link, Number(process.hrtime.bigint() - started) / 1e9);
  }
}

/** Indexer lag gauge (ledger close → history visible), seconds. */
export function setIndexerLag(seconds) {
  if (Number.isFinite(seconds) && seconds >= 0) {
    setGauge("helphone_indexer_lag_seconds", {}, seconds);
    observeLink("indexer.lag", seconds);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Kill-switch store + server-side enforcement (#797)
// ════════════════════════════════════════════════════════════════════════════

let flagState = { version: "1", kills: {}, issuedAt: Date.now() };
/** version → issuedAt, for time-to-effect. Capped to the last 20 versions. */
const flagIssued = new Map([[flagState.version, flagState.issuedAt]]);
/** Which version first killed each switch (for quarantine of stale envelopes). */
const killedAt = new Map();

export function currentFlags() {
  return { version: flagState.version, kills: { ...flagState.kills } };
}

export async function setKillSwitches(kills) {
  const next = String(Number(flagState.version) + 1);
  const merged = { ...flagState.kills, ...kills };
  for (const [key, enabled] of Object.entries(kills)) {
    if (enabled === false && flagState.kills[key] !== false) killedAt.set(key, next);
    if (enabled === true) killedAt.delete(key);
  }
  flagState = { version: next, kills: merged, issuedAt: Date.now() };
  flagIssued.set(next, flagState.issuedAt);
  while (flagIssued.size > 20) flagIssued.delete(flagIssued.keys().next().value);
  await publishFlagSnapshot({ version: next, kills: merged }).catch((err) =>
    console.error("[flags] publish failed, clients will converge via poll:", err.message));
  return currentFlags();
}

function clientFlagVersion(req) {
  const header = req.get?.("x-helphone-flag-version") ?? req.headers?.["x-helphone-flag-version"];
  const body = req.body?.dims?.flagVersion ?? req.body?.flagVersion;
  const v = header ?? body;
  return typeof v === "string" && /^\d{1,15}$/.test(v) ? v : null;
}

const COHORT_RE = /^[a-z0-9_-]{1,32}$/i;

/** Records which flag version a client reports and how long adoption took. */
function recordAdoption(req) {
  const version = clientFlagVersion(req);
  if (!version) return;
  const raw = req.body?.dims?.cohort;
  const cohort = typeof raw === "string" && COHORT_RE.test(raw) ? raw : "unknown";
  inc("helphone_flag_version_reports_total", { version, cohort });
  const issued = flagIssued.get(version);
  if (issued && version === flagState.version) observeBudgeted("helphone_flag_time_to_effect_seconds", { cohort }, (Date.now() - issued) / 1000);
}

/**
 * Enforces a kill-switch server-side so a client kill is never merely
 * advisory. Killed → 503 with Retry-After. A request stamped with a flag
 * version older than the kill is quarantined (409), not executed, so offline
 * drafts composed before the kill can be reviewed rather than silently run.
 */
export function enforceKillSwitch(key) {
  return (req, res, next) => {
    recordAdoption(req);
    if (flagState.kills[key] !== false) return next();
    const version = clientFlagVersion(req);
    const killVersion = killedAt.get(key);
    inc("helphone_kill_switch_rejections_total", { key });
    if (version && killVersion && Number(version) < Number(killVersion)) {
      return res.status(409).json({ error: "quarantined", killSwitch: key, flagVersion: version, killVersion });
    }
    res.set("Retry-After", "60");
    return res.status(503).json({ error: "kill_switch_active", killSwitch: key, flagVersion: flagState.version });
  };
}

export function flagsHandler(req, res) {
  recordAdoption(req);
  res.set("Cache-Control", "no-store").json(currentFlags());
}

const killBody = z.record(z.string().regex(/^[a-zA-Z][\w.]{0,63}$/), z.boolean()).refine((o) => Object.keys(o).length <= 64);

export async function setFlagsHandler(req, res) {
  const parsed = killBody.safeParse(req.body?.kills);
  if (!parsed.success) return res.status(400).json({ error: "invalid kills" });
  res.json(await setKillSwitches(parsed.data));
}

// ════════════════════════════════════════════════════════════════════════════
// Forensic envelope ingest (#793)
// ════════════════════════════════════════════════════════════════════════════

const FORENSIC_MAX_BYTES = 64 * 1024;
const FORENSIC_SIGNALS = [
  "ts", "jsHeapUsed", "jsHeapLimit", "workerQueueDepth", "workerPendingBytes", "workerHeartbeatAgeMs",
  "yjsBytes", "mapboxTiles", "mapboxStyleBytes", "ringBytes", "wasmBytes", "wasmGrowEvents",
  "parserAllocBytes", "storageUsage", "storageQuota",
];
const cell = z.number().finite().nonnegative().nullable();
const hintList = z.array(z.tuple([z.string().max(40).regex(/^[\w.:-]*$/), z.number().int().nonnegative()])).max(5);

export const forensicEnvelopeSchema = z.object({
  schema: z.literal("helphone.forensics/1"),
  reason: z.enum(["manual", "heartbeat_stall", "heap_near_limit", "storage_near_quota", "crash"]),
  ts: z.number().int().positive(),
  ua: z.enum(["chromium", "firefox", "webkit", "other"]),
  signals: z.array(z.string()).refine((s) => s.length === FORENSIC_SIGNALS.length && s.every((v, i) => v === FORENSIC_SIGNALS[i]), "unknown signal layout"),
  census: z.array(z.array(cell).length(FORENSIC_SIGNALS.length)).max(50),
  breakdown: z.record(z.enum(FORENSIC_SIGNALS), z.number().finite().nonnegative()),
  hints: z.object({ yjsTopMaps: hintList.optional(), mapboxTopSources: hintList.optional() }).strict(),
}).strict();

export function forensicIngestHandler(req, res) {
  const size = Number(req.get?.("content-length") ?? 0) || Buffer.byteLength(JSON.stringify(req.body ?? {}));
  if (size > FORENSIC_MAX_BYTES) return res.status(413).json({ error: "envelope too large" });
  const parsed = forensicEnvelopeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid envelope", issues: parsed.error.issues.slice(0, 5).map((i) => i.path.join(".")) });
  const env = parsed.data;
  inc("helphone_forensic_envelopes_total", { reason: env.reason, ua: env.ua });
  for (const [subsystem, bytes] of Object.entries(env.breakdown)) {
    setGauge("helphone_forensic_subsystem_bytes", { subsystem, ua: env.ua }, bytes);
  }
  console.log(JSON.stringify({ event: "heap_forensics", traceId: traceIdFromRequest(req), ...env }));
  res.status(202).json({ accepted: true });
}

// ════════════════════════════════════════════════════════════════════════════
// RUM vs synthetic dual ingest + divergence (#796)
// ════════════════════════════════════════════════════════════════════════════

const label = (max, re = /^[\w./:-]*$/) => z.string().max(max).regex(re);
const rumDims = z.object({
  route: label(80),
  cohort: label(32),
  deviceClass: z.enum(["low", "mid", "high"]),
  networkClass: z.enum(["offline", "slow-2g", "2g", "3g", "4g", "unknown"]),
  flagVersion: z.string().regex(/^\d{1,15}$/),
  synthetic: z.boolean(),
  runId: label(64).optional(),
  commitSha: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
});
const rumBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("timing"), step: label(40), seconds: z.number().finite().nonnegative().max(600), dims: rumDims }),
  z.object({ kind: z.literal("gap"), droppedSamples: z.number().int().nonnegative().max(1e6), offlineSeconds: z.number().int().nonnegative().max(30 * 86400), dims: rumDims }),
]);

export function rumIngestHandler(req, res) {
  const parsed = rumBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid rum sample" });
  const body = parsed.data;
  recordAdoption(req);
  const source = body.dims.synthetic ? "synthetic" : "rum";
  // commitSha/runId stay in logs, not labels: they would explode cardinality.
  const labels = { source, route: body.dims.route, step: body.kind === "timing" ? body.step : "gap", cohort: body.dims.cohort, device: body.dims.deviceClass, network: body.dims.networkClass };
  if (body.kind === "timing") {
    observeBudgeted("helphone_user_step_seconds", labels, body.seconds);
  } else {
    inc("helphone_rum_dropped_samples_total", { route: body.dims.route, cohort: body.dims.cohort }, body.droppedSamples);
    inc("helphone_rum_offline_seconds_total", { route: body.dims.route, cohort: body.dims.cohort }, body.offlineSeconds);
  }
  if (body.dims.synthetic) console.log(JSON.stringify({ event: "synthetic_sample", runId: body.dims.runId, commitSha: body.dims.commitSha, route: body.dims.route, step: labels.step }));
  res.status(202).json({ accepted: true });
}

function quantile(h, q) {
  if (!h || h.count === 0) return null;
  const target = h.count * q;
  let cumulative = 0;
  for (let i = 0; i < BUDGET_BUCKETS.length; i++) {
    cumulative += h.buckets[i];
    if (cumulative >= target) return BUDGET_BUCKETS[i];
  }
  return Infinity;
}

/**
 * Missing-RUM correction: received samples / (received + reported dropped).
 * Lower bound only — sessions that never reconnect report nothing.
 */
export function rumCoverage(route, cohort) {
  let received = 0;
  for (const h of histograms.values()) {
    if (h.name === "helphone_user_step_seconds" && h.labels.source === "rum" && h.labels.route === route && h.labels.cohort === cohort) received += h.count;
  }
  const dropped = counters.get(seriesKey("helphone_rum_dropped_samples_total", { route, cohort }))?.value ?? 0;
  return received + dropped === 0 ? null : received / (received + dropped);
}

/**
 * Paging rule (authority matrix, docs/telemetry-architecture.md):
 *   RUM red                     → page (regardless of synthetic)
 *   synthetic red, RUM green    → ticket
 *   synthetic red, no RUM data  → page (zero-coverage exception)
 *   otherwise                   → ok
 */
export function decideAlert({ rumP95, syntheticP95, budgetSeconds, rumCount, minRumSamples = 20 }) {
  const rumRed = rumCount >= minRumSamples && rumP95 != null && rumP95 > budgetSeconds;
  const synthRed = syntheticP95 != null && syntheticP95 > budgetSeconds;
  if (rumRed) return "page";
  if (synthRed && rumCount < minRumSamples) return "page";
  if (synthRed) return "ticket";
  return "ok";
}

export function divergence(route, step, cohort, budgetSeconds) {
  const pick = (source) => {
    const merged = { count: 0, buckets: Array(BUDGET_BUCKETS.length).fill(0) };
    for (const h of histograms.values()) {
      const l = h.labels;
      if (h.name !== "helphone_user_step_seconds" || l.source !== source || l.route !== route || l.step !== step || l.cohort !== cohort) continue;
      merged.count += h.count;
      h.buckets.forEach((n, i) => (merged.buckets[i] += n));
    }
    return merged;
  };
  const rum = pick("rum");
  const synthetic = pick("synthetic");
  const rumP95 = quantile(rum, 0.95);
  const syntheticP95 = quantile(synthetic, 0.95);
  return {
    route, step, cohort, budgetSeconds,
    rumP95, syntheticP95,
    deltaSeconds: rumP95 != null && syntheticP95 != null ? rumP95 - syntheticP95 : null,
    rumCount: rum.count,
    coverage: rumCoverage(route, cohort),
    decision: decideAlert({ rumP95, syntheticP95, budgetSeconds, rumCount: rum.count }),
  };
}

export function divergenceHandler(req, res) {
  const { route = "/help", step = "tapToConfirm", cohort = "default" } = req.query ?? {};
  const budget = Number(req.query?.budget) || (perfBudget.endToEnd?.tapToConfirm?.p75Ms ?? 2500) / 1000;
  res.json(divergence(String(route), String(step), String(cohort), budget));
}

// ── Exposition ───────────────────────────────────────────────────────────────

function fmtLabels(labels) {
  const e = Object.entries(labels);
  return e.length ? `{${e.map(([k, v]) => `${k}="${String(v).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"')}"`).join(",")}}` : "";
}

/** Prometheus text for every telemetry family above; appended to /metrics. */
export function renderTelemetryMetrics() {
  const lines = [];
  const typed = new Set();
  const head = (name, type, help) => {
    if (typed.has(name)) return;
    typed.add(name);
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  };
  for (const c of counters.values()) {
    head(c.name, "counter", "HelPhone telemetry counter.");
    lines.push(`${c.name}${fmtLabels(c.labels)} ${c.value}`);
  }
  for (const g of gauges.values()) {
    head(g.name, "gauge", "HelPhone telemetry gauge.");
    lines.push(`${g.name}${fmtLabels(g.labels)} ${g.value}`);
  }
  for (const h of histograms.values()) {
    head(h.name, "histogram", "Budget-aligned duration in seconds (buckets from perf-budget.json).");
    let cumulative = 0;
    BUDGET_BUCKETS.forEach((b, i) => {
      cumulative += h.buckets[i];
      lines.push(`${h.name}_bucket${fmtLabels({ ...h.labels, le: b })} ${cumulative}`);
    });
    lines.push(`${h.name}_bucket${fmtLabels({ ...h.labels, le: "+Inf" })} ${h.count}`);
    lines.push(`${h.name}_sum${fmtLabels(h.labels)} ${h.sum}`, `${h.name}_count${fmtLabels(h.labels)} ${h.count}`);
  }
  setGauge("helphone_flag_current_version", {}, Number(flagState.version));
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function resetTelemetryMetrics() {
  histograms.clear();
  counters.clear();
  gauges.clear();
}
