import { describe, it, expect, beforeEach } from "vitest";
import {
  OtelSamplingEngine,
  SamplingDecision,
  OTEL_SAMPLING_DECISION,
  createOtelSampler,
  createTailSamplingExporter,
} from "../server/lib/otelSamplingEngine.js";
import { renderSamplingMetrics, registerSamplingEngine } from "../server/telemetry.js";

describe("ISP-089: OpenTelemetry Sampling & Quota Protection Engine", () => {
  let sampler;

  beforeEach(() => {
    sampler = new OtelSamplingEngine({
      headSampleRatio: 0.05,
      highLatencyThresholdMs: 1000,
      salt: "test-telemetry-salt-999",
    });
  });

  describe("Pareto Drop Rules", () => {
    it("should drop health, readiness, and asset endpoints with zero allocation", () => {
      expect(sampler.evaluateSpan({ attributes: { "http.url": "/healthz" } }).decision).toBe(
        SamplingDecision.DROP
      );
      expect(sampler.evaluateSpan({ attributes: { "http.target": "/readyz" } }).decision).toBe(
        SamplingDecision.DROP
      );
      expect(sampler.evaluateSpan({ attributes: { "http.url": "/assets/main-1234.js" } }).decision).toBe(
        SamplingDecision.DROP
      );
      expect(
        sampler.evaluateSpan({ attributes: { "telemetry.category": "heartbeat", error: false } }).decision
      ).toBe(SamplingDecision.DROP);
    });
  });

  describe("Tail Sampling Guarantees", () => {
    it("should retain 100% of error spans regardless of head sample ratio", () => {
      for (let i = 0; i < 50; i++) {
        const result = sampler.evaluateSpan({
          name: "database_query",
          isError: true,
          attributes: { error: true, code: 500 },
        });
        expect(result.decision).toBe(SamplingDecision.RECORD_AND_SAMPLE);
        expect(result.reason).toBe("TAIL_ERROR_CAPTURE");
      }
    });

    it("should retain 100% of emergency dispatch spans", () => {
      const result = sampler.evaluateSpan({
        name: "emergency_dispatch_handler",
        attributes: { journey: "emergency_dispatch" },
      });
      expect(result.decision).toBe(SamplingDecision.RECORD_AND_SAMPLE);
      expect(result.reason).toBe("TAIL_CRITICAL_DISPATCH");
    });

    it("should retain spans exceeding high-latency threshold (>= 1000ms)", () => {
      const slowSpan = sampler.evaluateSpan({
        name: "wasm_zk_proof_verify",
        durationMs: 1450,
        attributes: { "http.url": "/api/verify" },
      });
      expect(slowSpan.decision).toBe(SamplingDecision.RECORD_AND_SAMPLE);
      expect(slowSpan.reason).toBe("TAIL_HIGH_LATENCY");
    });
  });

  describe("High-Cardinality & PII Sanitization", () => {
    it("should hash wallet addresses, IPs, and responder IDs into salted non-reversible pseudonyms", () => {
      const rawAttributes = {
        walletAddress: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        "client.ip": "192.168.1.105",
        "http.route": "/incidents/123e4567-e89b-12d3-a456-426614174000",
      };

      const sanitized = sampler.sanitizeAttributes(rawAttributes);

      expect(sanitized.walletAddress).toMatch(/^anon_[0-9a-f]{16}$/);
      expect(sanitized.walletAddress).not.toContain("GBBD47IF6LWK7P7M");
      expect(sanitized["client.ip"]).toMatch(/^anon_[0-9a-f]{16}$/);
      expect(sanitized["client.ip"]).not.toContain("192.168.1.105");

      // UUID parameterized to prevent metrics cardinality explosion
      expect(sanitized["http.route"]).toBe("/incidents/:id");
    });
  });

  describe("OTLP Exporter Circuit Breaker under 429 Quota Storm", () => {
    it("should shed background spans when exporter returns 429 rate limit", () => {
      sampler.recordExporterResponse(429);
      expect(sampler.isCircuitActive()).toBe(true);

      // Background span dropped
      const bgSpan = sampler.evaluateSpan({
        name: "fetch_map_tile",
        attributes: { "http.url": "/api/tiles/5/10" },
      });
      expect(bgSpan.decision).toBe(SamplingDecision.DROP);
      expect(bgSpan.reason).toBe("CIRCUIT_BREAKER_SHED");

      // Critical error spans STILL exported despite circuit breaker
      const errSpan = sampler.evaluateSpan({
        name: "failed_ledger_write",
        isError: true,
        attributes: { error: true },
      });
      expect(errSpan.decision).toBe(SamplingDecision.RECORD_AND_SAMPLE);
      expect(errSpan.reason).toBe("TAIL_ERROR_CAPTURE");
    });
  });

  describe("W3C Traceparent Header Parsing", () => {
    it("should parse standard traceparent headers correctly", () => {
      const headers = {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      };

      const extracted = sampler.extractTraceparent(headers);
      expect(extracted).not.toBeNull();
      expect(extracted.version).toBe("00");
      expect(extracted.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(extracted.parentId).toBe("00f067aa0ba902b7");
      expect(extracted.traceFlags).toBe("01");
    });
  });

  describe("Per-tenant quotas and SDK integration (#759)", () => {
    it("exhausts a tenant quota for background traffic but never sheds errors or P0 paths", () => {
      const engine = new OtelSamplingEngine({
        headSampleRatio: 0.05,
        defaultTenantQuota: 0.5,
        tenantQuotas: { "tenant-a": 0 },
      });
      const base = { name: "map_tile_fetch", traceId: "a".repeat(32), attributes: { "helphone.tenant": "tenant-a", "http.target": "/api/tiles/1" } };

      for (let i = 0; i < 20; i++) {
        const result = engine.evaluateSpan({ ...base, traceId: i.toString(16).padStart(32, "0") });
        expect(result.decision).toBe(SamplingDecision.DROP);
        expect(result.reason).toBe("TENANT_QUOTA_EXHAUSTED");
        expect(result.recordOnly).toBe(true);
      }
      expect(engine.getMetrics().byTenant["tenant-a"]).toBe(20);

      expect(engine.evaluateSpan({ ...base, isError: true }).decision).toBe(SamplingDecision.RECORD_AND_SAMPLE);
      expect(engine.evaluateSpan({
        ...base,
        attributes: { ...base.attributes, "http.route": "/api/dispatch/emergency" },
      }).reason).toBe("TAIL_CRITICAL_DISPATCH");
    });

    it("maps head decisions to OTel SamplingDecision and rescues late errors in the tail exporter", () => {
      const engine = new OtelSamplingEngine({ headSampleRatio: 0, tenantQuotas: { "tenant-b": 0 } });
      const sdkSampler = createOtelSampler(engine);
      const noise = sdkSampler.shouldSample({}, "1".repeat(32), "health_check", { "http.url": "/healthz" });
      expect(noise.decision).toBe(OTEL_SAMPLING_DECISION.NOT_RECORD);

      const background = sdkSampler.shouldSample({}, "2".repeat(32), "map_tile_fetch", { "helphone.tenant": "tenant-b", "http.url": "/api/tiles/1" });
      expect(background.decision).toBe(OTEL_SAMPLING_DECISION.RECORD_ONLY);

      const exported = [];
      const exporter = createTailSamplingExporter(engine, {
        export(spans, cb) { exported.push(...spans); cb({ code: 0 }); },
      });
      const fakeSpan = (statusCode) => ({
        name: "map_tile_fetch",
        duration: [0, 5_000_000],
        status: { code: statusCode },
        attributes: { "helphone.tenant": "tenant-b", "http.url": "/api/tiles/1" },
        spanContext: () => ({ traceId: "2".repeat(32), spanId: "3".repeat(16) }),
      });

      let result;
      exporter.export([fakeSpan(0)], (r) => { result = r; });
      expect(result.code).toBe(0);
      expect(exported).toHaveLength(0);

      exporter.export([fakeSpan(2)], () => {});
      expect(exported).toHaveLength(1);
      expect(engine.getMetrics().rescued).toBe(1);
    });

    it("exports drop counters in Prometheus text", () => {
      const engine = new OtelSamplingEngine();
      registerSamplingEngine(engine);
      engine.evaluateSpan({ attributes: { "http.url": "/healthz" } });
      engine.recordExporterResponse(429);
      engine.evaluateSpan({ name: "background", traceId: "f".repeat(32) });
      const text = renderSamplingMetrics();
      expect(text).toContain('helphone_otel_spans_dropped_total{stage="head",reason="PARETO_NOISE_RULE"} 1');
      expect(text).toContain('helphone_otel_exporter_circuit_active 1');
      expect(text).toContain("helphone_otel_spans_rescued_total 0");
    });
  });
});
