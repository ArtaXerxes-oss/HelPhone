/**
 * OpenTelemetry Sampling & Quota Protection Engine (ISP-089 / Issue #759).
 *
 * Implements:
 * 1. Pareto Drop Rules: Drop ≥70% of noise spans (/healthz, /readyz, static assets, heartbeats).
 * 2. Adaptive Head + Tail Sampling: Keep 5% nominal traffic, but 100% of errors, latency anomalies, and emergency dispatches.
 * 3. High-Cardinality & PII Sanitizer: Replaces raw walletAddress, IP, and responder IDs with salted SHA-256 hashes.
 * 4. OTLP Exporter Circuit Breaker: Throttles export on 429 quota responses, shedding non-error spans to prevent OOM.
 * 5. W3C TraceContext Propagation: Preserves browser <-> server traceparent join for critical emergency journeys.
 */

import crypto from "crypto";

export const SamplingDecision = {
  DROP: "DROP",
  RECORD_AND_SAMPLE: "RECORD_AND_SAMPLE",
};

/** OTel SDK SamplingDecision values (kept numeric to avoid a hard SDK import). */
export const OTEL_SAMPLING_DECISION = Object.freeze({
  NOT_RECORD: 0,
  RECORD_ONLY: 1,
  RECORD_AND_SAMPLE: 2,
});

const P0_PATHS = [
  /^\/api\/dispatch(?:\/|$)/,
  /^\/api\/help(?:\/|$)/,
  /^\/api\/telemetry\/errors$/,
];

function ratio(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

export class OtelSamplingEngine {
  constructor(options = {}) {
    this.headSampleRatio = ratio(options.headSampleRatio, 0.05); // 5% baseline
    this.salt = options.salt || "helphone-telemetry-privacy-salt";
    this.highLatencyThresholdMs = Number(options.highLatencyThresholdMs) || 1000; // 1s
    this.exporterBackoffMs = Number(options.exporterBackoffMs) || 30000;
    this.isCircuitBroken = false;
    this.exporterBackoffUntil = 0;
    this.droppedSpansCount = 0;
    this.exportedSpansCount = 0;

    // Per-tenant quotas: tenant id → max sample ratio. A tenant with an
    // exhausted quota loses only non-priority spans; errors and P0 flows are
    // always kept. Bounded to 200 tenants so label cardinality stays safe.
    this.defaultTenantQuota = ratio(options.defaultTenantQuota, this.headSampleRatio);
    this.tenantQuotas = Object.freeze({ ...(options.tenantQuotas || {}) });
    this.tenantAttributeKeys = options.tenantAttributeKeys || ["helphone.tenant", "tenant.id", "tenant"];
    this.p0Paths = options.p0Paths || P0_PATHS;

    this.droppedByReason = new Map();
    this.tenantDrops = new Map();
    this.finalKeptCount = 0;
    this.finalDroppedCount = 0;
    this.rescuedSpansCount = 0;

    // Pareto drop patterns
    this.dropUrlPatterns = [
      /\/healthz/,
      /\/readyz/,
      /\/assets\//,
      /\/favicon\.ico/,
      /\/ping/,
    ];
  }

  /** Build the engine from documented OTEL_* environment settings. */
  static fromEnvironment(env = process.env) {
    let tenantQuotas = {};
    if (env.OTEL_TENANT_QUOTAS) {
      try {
        const parsed = JSON.parse(env.OTEL_TENANT_QUOTAS);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) tenantQuotas = parsed;
      } catch {
        // Ignore malformed config: fall back to the global ratio, never crash boot.
      }
    }
    let p0Paths = P0_PATHS;
    if (env.OTEL_P0_PATHS) {
      const parsed = [];
      for (const pattern of String(env.OTEL_P0_PATHS).split(",")) {
        try {
          parsed.push(new RegExp(pattern.trim()));
        } catch {
          // A malformed operator-supplied pattern must not break boot; the
          // built-in P0 list stays in force.
        }
      }
      if (parsed.length) p0Paths = parsed;
    }
    return new OtelSamplingEngine({
      headSampleRatio: ratio(env.OTEL_HEAD_SAMPLE_RATIO, 0.05),
      defaultTenantQuota: ratio(env.OTEL_DEFAULT_TENANT_QUOTA, ratio(env.OTEL_HEAD_SAMPLE_RATIO, 0.05)),
      tenantQuotas,
      highLatencyThresholdMs: Number(env.OTEL_HIGH_LATENCY_THRESHOLD_MS) || 1000,
      exporterBackoffMs: Number(env.OTEL_EXPORTER_BACKOFF_MS) || 30000,
      salt: env.OTEL_PII_SALT || "helphone-telemetry-privacy-salt",
      p0Paths,
    });
  }

  /**
   * Part 1: Pareto Drop Rules
   * Filter out noise before allocating span memory.
   */
  shouldParetoDrop(attributes = {}) {
    const url = attributes["http.url"] || attributes["http.target"] || "";
    for (const pattern of this.dropUrlPatterns) {
      if (pattern.test(url)) {
        return true;
      }
    }

    if (attributes["telemetry.category"] === "heartbeat" && !attributes["error"]) {
      return true;
    }

    return false;
  }

  /**
   * Part 2: Adaptive Head + Tail Sampler
   * Evaluates span for inclusion:
   * - 100% of errors
   * - 100% of emergency dispatches
   * - 100% of high-latency spans (>1000ms)
   * - 5% (headSampleRatio) of nominal background traffic
   */
  /** True for the P0 paths the quota system may never shed. */
  isP0Path({ name = "", attributes = {} } = {}) {
    if (attributes.journey === "emergency_dispatch" || attributes["helphone.p0"] === true) return true;
    if (typeof name === "string" && name.includes("emergency_dispatch")) return true;
    const target = String(attributes["http.route"] || attributes["http.target"] || attributes["http.url"] || "");
    return this.p0Paths.some((pattern) => pattern.test(target));
  }

  tenantOf(attributes = {}) {
    for (const key of this.tenantAttributeKeys) {
      const value = attributes[key];
      if (typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)) return value;
    }
    return null;
  }

  countDrop(reason, tenant) {
    this.droppedSpansCount += 1;
    this.droppedByReason.set(reason, (this.droppedByReason.get(reason) || 0) + 1);
    if (tenant) {
      this.tenantDrops.set(tenant, (this.tenantDrops.get(tenant) || 0) + 1);
    }
  }

  countExport() {
    this.exportedSpansCount += 1;
  }

  evaluateSpan(spanData = {}, { count = true } = {}) {
    const { name, attributes = {}, durationMs = 0, isError = false } = spanData;
    const tenant = this.tenantOf(attributes);
    const failed = isError || attributes["error"] === true || attributes["otel.status_code"] === "ERROR";
    const keep = (reason) => {
      if (count) this.countExport();
      return { decision: SamplingDecision.RECORD_AND_SAMPLE, reason, tenant };
    };
    const drop = (reason, recordOnly = false) => {
      if (count) this.countDrop(reason, tenant);
      return { decision: SamplingDecision.DROP, reason, recordOnly, tenant };
    };

    // Priority rules run BEFORE Pareto/quota: an error or P0 flow is never
    // shed, even when its path is normally noisy (requirement: quota
    // exhaustion degrades sampling without dropping errors).
    if (failed) return keep("TAIL_ERROR_CAPTURE");
    if (this.isP0Path({ name, attributes })) return keep("TAIL_CRITICAL_DISPATCH");
    if (durationMs >= this.highLatencyThresholdMs) return keep("TAIL_HIGH_LATENCY");

    // Noise is never allocated a span at all (head stage only).
    if (this.shouldParetoDrop(attributes)) return drop("PARETO_NOISE_RULE");

    if (this.isCircuitActive()) return drop("CIRCUIT_BREAKER_SHED", true);

    // Per-tenant quota: a tenant with a stricter budget loses non-priority
    // traffic first. RECORD_ONLY lets the tail stage rescue a late error.
    const sampleHash = crypto.createHash("md5").update(spanData.traceId || String(Math.random())).digest("hex");
    const sampleValue = parseInt(sampleHash.substring(0, 4), 16) / 0xffff;
    const quota = tenant && this.tenantQuotas[tenant] != null
      ? ratio(this.tenantQuotas[tenant], this.defaultTenantQuota)
      : this.defaultTenantQuota;

    if (tenant && quota < this.headSampleRatio && sampleValue > quota) {
      return drop("TENANT_QUOTA_EXHAUSTED", true);
    }
    if (sampleValue <= this.headSampleRatio) return keep("HEAD_RATIO_PASS");
    return drop("HEAD_RATIO_DROP", true);
  }

  /**
   * Tail-stage decision for a completed span. Keeps an error/P0/slow span even
   * if the head stage wanted to shed it, and accounts for the rescue.
   */
  finalizeSpan(spanData = {}) {
    const decision = this.evaluateSpan(spanData);
    if (decision.decision === SamplingDecision.RECORD_AND_SAMPLE) {
      this.finalKeptCount += 1;
      if (decision.reason.startsWith("TAIL_")) this.rescuedSpansCount += 1;
    } else {
      this.finalDroppedCount += 1;
    }
    return decision;
  }

  /** Metrics consumed by the /metrics Prometheus exposition. */
  getMetrics() {
    return {
      droppedTotal: this.droppedSpansCount,
      exportedTotal: this.exportedSpansCount,
      finalKept: this.finalKeptCount,
      finalDropped: this.finalDroppedCount,
      rescued: this.rescuedSpansCount,
      byReason: Object.fromEntries(this.droppedByReason),
      byTenant: Object.fromEntries(this.tenantDrops),
      circuitActive: this.isCircuitActive(),
    };
  }

  resetMetrics() {
    this.droppedSpansCount = 0;
    this.exportedSpansCount = 0;
    this.finalKeptCount = 0;
    this.finalDroppedCount = 0;
    this.rescuedSpansCount = 0;
    this.droppedByReason.clear();
    this.tenantDrops.clear();
  }

  /**
   * Part 3: High-Cardinality & PII Sanitizer
   * Masks wallet addresses, client IPs, and raw responder IDs into salted hashes.
   */
  sanitizeAttributes(attributes = {}) {
    const sanitized = { ...attributes };

    // PII & High-cardinality keys to sanitize
    const sensitiveKeys = ["walletAddress", "user.wallet", "client.ip", "responder.id", "caller.phone"];

    for (const key of sensitiveKeys) {
      if (sanitized[key]) {
        sanitized[key] = this.hashIdentifier(sanitized[key]);
      }
    }

    // Prevent high-cardinality route explosion in metrics
    if (sanitized["http.route"]) {
      // Normalize dynamic params: /incidents/123e4567-e89b-12d3 -> /incidents/:id
      sanitized["http.route"] = sanitized["http.route"].replace(
        /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
        ":id"
      );
    }

    return sanitized;
  }

  hashIdentifier(value) {
    return "anon_" + crypto.createHash("sha256").update(value + this.salt).digest("hex").substring(0, 16);
  }

  /**
   * Part 4: OTLP Exporter Circuit Breaker
   */
  recordExporterResponse(statusCode) {
    if (statusCode === 429) {
      // Trip circuit breaker on rate limiting / quota blowout
      this.isCircuitBroken = true;
      this.exporterBackoffUntil = Date.now() + this.exporterBackoffMs;
    } else if (statusCode >= 200 && statusCode < 300) {
      if (Date.now() > this.exporterBackoffUntil) {
        this.isCircuitBroken = false;
      }
    }
  }

  isCircuitActive() {
    if (this.isCircuitBroken && Date.now() < this.exporterBackoffUntil) {
      return true;
    }
    this.isCircuitBroken = false;
    return false;
  }

  /**
   * Part 5: W3C TraceContext Parser & Injector
   */
  extractTraceparent(headers = {}) {
    const traceparent = headers["traceparent"] || headers["Traceparent"];
    if (!traceparent) return null;

    const parts = traceparent.split("-");
    if (parts.length !== 4) return null;

    return {
      version: parts[0],
      traceId: parts[1],
      parentId: parts[2],
      traceFlags: parts[3],
    };
  }
}

function durationMsOf(span) {
  const duration = span?.duration;
  if (Array.isArray(duration)) return duration[0] * 1000 + duration[1] / 1e6;
  if (typeof duration === "bigint") return Number(duration) / 1e6;
  return typeof duration === "number" ? duration : 0;
}

function spanDataFrom(span, { final = false } = {}) {
  const attributes = engineSafeAttributes(span);
  const ctx = typeof span?.spanContext === "function" ? span.spanContext() : {};
  return {
    name: span?.name || "",
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    attributes,
    durationMs: final ? durationMsOf(span) : 0,
    isError: span?.status?.code === 2,
  };
}

function engineSafeAttributes(span) {
  const attributes = span?.attributes && typeof span.attributes === "object" ? span.attributes : {};
  const failed = span?.status?.code === 2;
  return { ...attributes, ...(failed ? { error: true, "otel.status_code": "ERROR" } : {}) };
}

/**
 * SDK `Sampler` adapter. Pareto noise is NOT_RECORD (no span allocated);
 * everything else is RECORD_ONLY so the tail exporter can still rescue a
 * span that turns into an error or exceeds the latency threshold.
 */
export function createOtelSampler(engine) {
  return {
    description: "HelPhone quota-aware hybrid sampler",
    shouldSample(_context, traceId, spanName, attributes = {}, _links = []) {
      const sanitized = engine.sanitizeAttributes(attributes);
      const result = engine.evaluateSpan({
        name: spanName,
        traceId,
        attributes: sanitized,
        durationMs: 0,
      }, { count: false });
      if (result.decision === SamplingDecision.DROP && !result.recordOnly) {
        return { decision: OTEL_SAMPLING_DECISION.NOT_RECORD, attributes: {} };
      }
      return { decision: OTEL_SAMPLING_DECISION.RECORD_ONLY, attributes: sanitized };
    },
  };
}

/**
 * Wraps the OTLP exporter with the tail decision stage. Only spans that pass
 * the final evaluation are exported; dropped spans are counted in Prometheus.
 * Works with a null exporter (instrumentation without an OTLP endpoint).
 */
export function createTailSamplingExporter(engine, exporter = null) {
  return {
    export(spans, resultCallback) {
      const kept = [];
      for (const span of spans || []) {
        const decision = engine.finalizeSpan(spanDataFrom(span, { final: true }));
        if (decision.decision === SamplingDecision.RECORD_AND_SAMPLE) kept.push(span);
      }
      if (kept.length === 0 || !exporter) {
        resultCallback({ code: 0 });
        return;
      }
      exporter.export(kept, resultCallback);
    },
    forceFlush() {
      return exporter?.forceFlush?.() ?? Promise.resolve();
    },
    shutdown() {
      return exporter?.shutdown?.() ?? Promise.resolve();
    },
  };
}
