import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { scrubText } from "./lib/redact.js";

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
