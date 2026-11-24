/**
 * Telemetry pipeline: producer → adaptive sampler → priority ring → exporter.
 *
 * The ring is the source of truth for admission/eviction; this class adds
 * network-aware sampling, bounded export batches, offline outbox diversion,
 * and reason-coded accounting that the TelemetryLab consumes.
 *
 * Also incorporates OpenTelemetry integration for error tracking and performance monitoring
 * Issue #746: Link errors to OTel traces for debugging blob-worker failures
 * Issue #754: Track GraphQL subscription transport performance
 */

import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import {
  formatTraceparent,
  parseTraceparent,
  traceHeaders as wireTraceHeaders,
  traceIdsFromTraceparent,
  unwrapFromWorker as wireUnwrapFromWorker,
  wrapForWorker as wireWrapForWorker,
} from './traceWire.js';

import {
  RingBuffer,
  type PressureEvent,
  type PressureLevel,
  type RingBufferOptions,
  type RingDropReason,
  type TelemetryFrame,
  type TelemetryPriority,
} from './ringBuffer';
import {
  profileFor,
  type NetworkClass,
  type NetworkProfile,
} from './networkEstimator';
import {
  TelemetryRedactor,
  hasPlaintextCoordinates,
  redactTelemetryAttributes,
  type AggregatedTelemetry,
  type TelemetryEvent,
} from './telemetryRedactor';

// ADR-014 follow-up: binary map-frame transport (extends, not replaces, the
// pipeline above). Kept in this module so consumers have one telemetry entry.
import { verifyFrame } from './telemetryFrame.js';
import type { Frame as MapFrame } from '../schemas/telemetry_generated.js';

export type TelemetryDropReason =
  | RingDropReason
  | 'sampled'
  | 'backpressure'
  | 'export_fail'
  | 'parse_error';

export interface TelemetrySpanInput {
  name: string;
  priority?: TelemetryPriority;
  kind?: string;
  ts?: number;
  durationMs?: number;
  attributes?: Record<string, unknown>;
}

export interface TelemetrySpan extends TelemetrySpanInput {
  seq: number;
  priority: TelemetryPriority;
  kind: string;
  ts: number;
}

export interface TelemetryExporter {
  export(spans: TelemetrySpan[]): Promise<void>;
}

export interface TelemetryOutbox {
  enqueue(spans: TelemetrySpan[]): Promise<void>;
}

export interface TelemetryPipelineOptions {
  capacity?: number;
  networkClass?: NetworkClass;
  exporter?: TelemetryExporter | null;
  outbox?: TelemetryOutbox | null;
  redactor?: TelemetryRedactor;
  drainIntervalMs?: number;
  onAggregatedDrain?: (batches: AggregatedTelemetry[]) => void | Promise<void>;
  now?: () => number;
  autoStart?: boolean;
  ring?: Partial<RingBufferOptions>;
}

export interface FlushResult {
  status: 'empty' | 'exported' | 'outbox' | 'failed' | 'in_flight';
  count: number;
  error?: string;
  retryAfterMs?: number;
}

export interface TelemetrySnapshot {
  produced: number;
  parsed: number;
  sampled: number;
  admitted: number;
  exported: number;
  outboxed: number;
  exportFailed: number;
  dropped: number;
  droppedReasons: Record<TelemetryDropReason, number>;
  queueDepth: number;
  inFlight: number;
  occupancy: number;
  pressure: PressureLevel;
  networkClass: NetworkClass;
  profile: NetworkProfile;
  exporterHealthy: boolean;
  lastError: string | null;
  lastExportAt: number | null;
  conservation: {
    offeredOk: boolean;
    admittedOk: boolean;
    accountingOk: boolean;
    ok: boolean;
    accounted: number;
  };
}

function emptyReasons(): Record<TelemetryDropReason, number> {
  return {
    overflow_heartbeat: 0,
    overflow_normal: 0,
    overflow_critical: 0,
    sampled: 0,
    backpressure: 0,
    export_fail: 0,
    parse_error: 0,
  };
}

/** Deterministic sampler: same sequence number → same decision. */
export function shouldSample(seq: number, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const mixed = (Math.imul((seq | 0) ^ 0x9e3779b9, 2654435761) >>> 0) / 0x1_0000_0000;
  return mixed < rate;
}

export function samplingRate(
  profile: NetworkProfile,
  pressure: PressureLevel,
  priority: TelemetryPriority,
): number {
  if (priority === 'critical') return 1;
  const base = priority === 'heartbeat' ? profile.heartbeatSampleRate : profile.normalSampleRate;
  if (pressure === 'critical') return Math.max(0, base * 0.1);
  if (pressure === 'high') return Math.max(0, base * 0.5);
  return Math.max(0, Math.min(1, base));
}

export class TelemetryPipeline {
  readonly ring: RingBuffer<TelemetrySpan>;
  readonly redactor: TelemetryRedactor;
  private networkClass: NetworkClass;
  private profile: NetworkProfile;
  private exporter: TelemetryExporter | null;
  private outbox: TelemetryOutbox | null;
  private readonly drainIntervalMs?: number;
  private readonly onAggregatedDrain?: (batches: AggregatedTelemetry[]) => void | Promise<void>;
  private readonly now: () => number;

  private sequence = 0;
  private produced = 0;
  private parsed = 0;
  private sampled = 0;
  private exported = 0;
  private outboxed = 0;
  private exportFailed = 0;
  private backpressureDropped = 0;
  private exportFailReasons = 0;
  private parseErrors = 0;
  private inFlight = 0;
  private flushing = false;
  private exporterHealthy = true;
  private lastError: string | null = null;
  private lastExportAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(options: TelemetryPipelineOptions = {}) {
    this.ring = new RingBuffer<TelemetrySpan>({
      capacity: options.capacity ?? 2_048,
      ...(options.ring || {}),
    });
    this.redactor = options.redactor ?? new TelemetryRedactor();
    this.networkClass = options.networkClass ?? '4g';
    this.profile = profileFor(this.networkClass);
    this.exporter = options.exporter ?? null;
    this.outbox = options.outbox ?? null;
    this.drainIntervalMs = options.drainIntervalMs;
    this.onAggregatedDrain = options.onAggregatedDrain;
    this.now = options.now ?? (() => Date.now());
    if (options.autoStart) this.start();
  }

  get network(): NetworkClass {
    return this.networkClass;
  }

  get batchProfile(): NetworkProfile {
    return this.profile;
  }

  record(input: TelemetrySpanInput): boolean {
    this.produced++;
    const priority = input.priority ?? 'normal';
    const pressure = this.ring.pressureLevel;

    // 90%+ occupancy: producers shed non-critical work explicitly. Critical
    // dispatch frames keep flowing until the ring itself is entirely critical.
    if (pressure === 'critical' && priority !== 'critical') {
      this.backpressureDropped++;
      return false;
    }

    const rate = samplingRate(this.profile, pressure, priority);
    if (!shouldSample(this.sequence, rate)) {
      this.sampled++;
      this.ring.recordSampled(1);
      return false;
    }

    const ts = input.ts ?? this.now();
    const rawAttrs = input.attributes;
    if (rawAttrs && hasPlaintextCoordinates(rawAttrs)) {
      const lat = Number(rawAttrs.lat ?? rawAttrs.latitude ?? rawAttrs['dispatch.lat']);
      const lng = Number(rawAttrs.lng ?? rawAttrs.longitude ?? rawAttrs.lon ?? rawAttrs['dispatch.lng']);
      const gpsEvent: TelemetryEvent = {
        type: input.kind ?? input.name,
        timestamp: ts,
        ...(Number.isFinite(lat) && Number.isFinite(lng) ? { location: { lat, lng } } : {}),
        data: rawAttrs,
      };
      void this.redactor.redactEvent(gpsEvent);
    }

    const span: TelemetrySpan = {
      name: input.name,
      priority,
      kind: input.kind ?? input.name,
      ts,
      durationMs: input.durationMs,
      attributes: redactTelemetryAttributes(rawAttrs),
      seq: this.sequence++,
    };

    return this.ring.push({
      seq: span.seq,
      priority,
      kind: span.kind,
      ts: span.ts,
      payload: span,
    });
  }

  recordParsed(count = 1): void {
    if (count > 0) this.parsed += count;
  }

  /**
   * Account for a frame/span dropped outside the ring (shed before parsing,
   * parse error, or explicit backpressure). This is a producer-side event, so
   * it increments `produced` as well as the reason counter.
   */
  recordDropped(reason: TelemetryDropReason, count = 1): void {
    if (count <= 0) return;
    this.produced += count;
    if (reason === 'sampled') this.sampled += count;
    else if (reason === 'backpressure') this.backpressureDropped += count;
    else if (reason === 'export_fail') this.exportFailReasons += count;
    else if (reason === 'parse_error') this.parseErrors += count;
    // Ring overflow reasons are owned by RingBuffer when frames are admitted.
  }

  /** Drain + export one bounded batch. Never throws. */
  async flush(): Promise<FlushResult> {
    if (this.flushing) return { status: 'in_flight', count: 0 };
    this.flushing = true;

    const batchSize = Math.max(1, this.profile.maxExportBatchSize);
    const frames = this.ring.drain(batchSize);
    if (frames.length === 0) {
      this.flushing = false;
      return { status: 'empty', count: 0 };
    }

    const rawSpans = frames.map((frame) => frame.payload);
    const spans: TelemetrySpan[] = [];
    let rejectedCount = 0;
    for (const span of rawSpans) {
      if (hasPlaintextCoordinates(span.attributes)) {
        rejectedCount++;
        continue;
      }
      spans.push(span);
    }
    if (rejectedCount > 0) {
      this.parseErrors += rejectedCount;
      this.lastError = 'plaintext coordinates rejected on flush';
    }
    if (spans.length === 0) {
      this.flushing = false;
      return { status: 'failed', count: 0, error: this.lastError ?? 'redaction bypass detected' };
    }
    this.inFlight += spans.length;
    try {
      if (this.profile.outboxOnly || this.networkClass === 'offline') {
        if (this.outbox) {
          await this.outbox.enqueue(spans);
          this.outboxed += spans.length;
          return { status: 'outbox', count: spans.length };
        }
        // No durable outbox: do not pretend these were exported.
        this.exportFailed += spans.length;
        this.exportFailReasons += spans.length;
        this.exporterHealthy = false;
        this.lastError = 'offline without outbox';
        return { status: 'failed', count: spans.length, error: this.lastError };
      }

      if (!this.exporter) {
        this.exportFailed += spans.length;
        this.exportFailReasons += spans.length;
        this.lastError = 'no exporter configured';
        return { status: 'failed', count: spans.length, error: this.lastError };
      }

      await this.exporter.export(spans);
      this.exported += spans.length;
      this.exporterHealthy = true;
      this.lastExportAt = this.now();
      this.lastError = null;
      return { status: 'exported', count: spans.length };
    } catch (error) {
      this.exportFailed += spans.length;
      this.exportFailReasons += spans.length;
      this.exporterHealthy = false;
      this.lastError = String((error as { message?: string })?.message ?? error);
      const retryAfterMs = Number((error as { retryAfterMs?: number })?.retryAfterMs);
      return {
        status: 'failed',
        count: spans.length,
        error: this.lastError,
        retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
      };
    } finally {
      this.inFlight = Math.max(0, this.inFlight - spans.length);
      this.flushing = false;
    }
  }

  setNetworkClass(networkClass: NetworkClass): void {
    if (networkClass === this.networkClass) return;
    this.networkClass = networkClass;
    this.profile = profileFor(networkClass);
    this.reschedule();
  }

  setExporter(exporter: TelemetryExporter | null): void {
    this.exporter = exporter;
  }

  setOutbox(outbox: TelemetryOutbox | null): void {
    this.outbox = outbox;
  }

  onPressure(listener: (event: PressureEvent) => void): () => void {
    return this.ring.onPressure(listener);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.reschedule();
    if (this.drainIntervalMs && this.drainIntervalMs > 0) {
      this.redactor.startDrainTimer(this.drainIntervalMs, this.onAggregatedDrain);
    }
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.redactor.stopDrainTimer();
  }

  snapshot(): TelemetrySnapshot {
    const ring = this.ring.snapshot();
    const reasons = emptyReasons();
    reasons.overflow_heartbeat = ring.droppedReasons.overflow_heartbeat;
    reasons.overflow_normal = ring.droppedReasons.overflow_normal;
    reasons.overflow_critical = ring.droppedReasons.overflow_critical;
    reasons.sampled = this.sampled;
    reasons.backpressure = this.backpressureDropped;
    reasons.export_fail = this.exportFailReasons;
    reasons.parse_error = this.parseErrors;

    const dropped =
      ring.rejected +
      ring.evicted +
      this.sampled +
      this.backpressureDropped +
      this.exportFailed +
      this.parseErrors;
    const accounted = this.exported + this.outboxed + dropped + ring.size + this.inFlight;
    const accountingOk = accounted === this.produced;
    const offeredOk = ring.conservation.offeredOk;
    const admittedOk = ring.conservation.admittedOk;

    return {
      produced: this.produced,
      parsed: this.parsed,
      sampled: this.sampled,
      admitted: ring.admitted,
      exported: this.exported,
      outboxed: this.outboxed,
      exportFailed: this.exportFailed,
      dropped,
      droppedReasons: reasons,
      queueDepth: ring.size,
      inFlight: this.inFlight,
      occupancy: ring.occupancy,
      pressure: ring.pressure,
      networkClass: this.networkClass,
      profile: this.profile,
      exporterHealthy: this.exporterHealthy,
      lastError: this.lastError,
      lastExportAt: this.lastExportAt,
      conservation: {
        offeredOk,
        admittedOk,
        accountingOk,
        ok: offeredOk && admittedOk && accountingOk,
        accounted,
      },
    };
  }

  reset(): void {
    this.ring.reset();
    this.produced = 0;
    this.parsed = 0;
    this.sampled = 0;
    this.exported = 0;
    this.outboxed = 0;
    this.exportFailed = 0;
    this.backpressureDropped = 0;
    this.exportFailReasons = 0;
    this.parseErrors = 0;
    this.inFlight = 0;
    this.flushing = false;
    this.exporterHealthy = true;
    this.lastError = null;
    this.lastExportAt = null;
    this.sequence = 0;
  }

  private reschedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started) return;
    const delay = this.profile.scheduledDelayMillis;
    if (delay <= 0) return; // offline/manual flush only
    this.timer = setTimeout(() => {
      this.flush().finally(() => this.reschedule());
    }, delay);
    // Do not keep a Node process alive just for telemetry exports.
    (this.timer as { unref?: () => void }).unref?.();
  }
}

/** In-memory exporter used by tests and the lab. */
export function createMemoryExporter(options: { maxBatches?: number } = {}): TelemetryExporter & {
  batches: TelemetrySpan[][];
  reset(): void;
} {
  const maxBatches = options.maxBatches ?? 100;
  const batches: TelemetrySpan[][] = [];
  return {
    batches,
    async export(spans) {
      if (spans.length === 0) return;
      batches.push(spans);
      while (batches.length > maxBatches) batches.shift();
    },
    reset() {
      batches.length = 0;
    },
  };
}

export interface OtlpExporterOptions {
  endpoint: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  headers?: Record<string, string>;
  serviceName?: string;
}

/**
 * Minimal OTLP/HTTP JSON exporter. Avoids pulling the server-oriented
 * @opentelemetry/sdk-node bundle into the browser just for batching.
 */
export function createOtlpHttpExporter(options: OtlpExporterOptions): TelemetryExporter {
  const {
    endpoint,
    fetchImpl = globalThis.fetch,
    timeoutMs = 5_000,
    headers = {},
    serviceName = 'helphone-web',
  } = options;

  return {
    async export(spans) {
      if (spans.length === 0) return;
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(toOtlpJson(spans, serviceName)),
          signal: controller?.signal,
          keepalive: spans.length <= 32,
        });
        if (!response.ok) {
          const retryAfter = Number(response.headers?.get?.('retry-after'));
          const error = new Error(`OTLP export failed: HTTP ${response.status}`) as Error & {
            status?: number;
            retryAfterMs?: number;
          };
          error.status = response.status;
          if (Number.isFinite(retryAfter)) error.retryAfterMs = Math.max(0, retryAfter * 1_000);
          throw error;
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

export function toOtlpJson(spans: TelemetrySpan[], serviceName = 'helphone-web'): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: serviceName } },
            { key: 'telemetry.sdk.language', value: { stringValue: 'webjs' } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'helphone.telemetry', version: '1.0.0' },
            spans: spans.map((span) => ({
              traceId: traceIdFor(span.seq),
              spanId: spanIdFor(span.seq),
              name: span.name,
              kind: 1,
              startTimeUnixNano: String(Math.round(span.ts * 1e6)),
              endTimeUnixNano: String(Math.round((span.ts + (span.durationMs ?? 0)) * 1e6)),
              attributes: [
                { key: 'helphone.priority', value: { stringValue: span.priority } },
                { key: 'helphone.kind', value: { stringValue: span.kind } },
                ...Object.entries(redactTelemetryAttributes(span.attributes) || {}).map(([key, value]) => ({
                  key,
                  value:
                    typeof value === 'number'
                      ? { doubleValue: value }
                      : typeof value === 'boolean'
                        ? { boolValue: value }
                        : { stringValue: String(value) },
                })),
              ],
            })),
          },
        ],
      },
    ],
  };
}

function traceIdFor(seq: number): string {
  // Stable, non-cryptographic id derived from the sequence; good enough for
  // correlation in the lab and avoids Math.random() in hot paths.
  const high = (Math.imul(seq, 2654435761) >>> 0).toString(16).padStart(8, '0');
  const low = (Math.imul(seq ^ 0x9e3779b9, 40503) >>> 0).toString(16).padStart(8, '0');
  return `${high}${low}`.padEnd(32, '0').slice(0, 32);
}

function spanIdFor(seq: number): string {
  return (Math.imul(seq ^ 0x85ebca6b, 2246822507) >>> 0).toString(16).padStart(8, '0').padEnd(16, '0').slice(0, 16);
}

const tracer = trace.getTracer('helphone');

// #791: the trace id recorded on the IDB crash draft must be the same one the
// HTTP/worker hops carry. sessionStorage is the fallback when no span is
// active (e.g. a draft autosave between dispatches).
const TRACE_ID_KEY = 'otel_trace_id'
const SPAN_ID_KEY = 'otel_span_id'

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

function rememberTrace(traceparent: string | null | undefined): void {
  const ids = traceIdsFromTraceparent(traceparent)
  const store = storage()
  if (!ids || !store) return
  try {
    store.setItem(TRACE_ID_KEY, ids.traceId)
    store.setItem(SPAN_ID_KEY, ids.spanId)
  } catch {}
}

function storedTraceparent(): string | null {
  const store = storage()
  if (!store) return null
  try {
    const traceId = store.getItem(TRACE_ID_KEY)
    const spanId = store.getItem(SPAN_ID_KEY)
    return traceId && spanId ? formatTraceparent({ traceId, spanId }) : null
  } catch {
    return null
  }
}

function traceparentFromSpanContext(ctx: { traceId: string; spanId: string; traceFlags: number | string }): string {
  const flags = typeof ctx.traceFlags === 'string'
    ? ctx.traceFlags
    : Number(ctx.traceFlags).toString(16).padStart(2, '0')
  return formatTraceparent({ traceId: ctx.traceId, spanId: ctx.spanId, flags })
}

/** Active OTel span, or the last trace remembered on this tab. */
function activeTraceparent(): string | null {
  const span = trace.getActiveSpan()
  if (span) {
    const traceparent = traceparentFromSpanContext(span.spanContext())
    if (parseTraceparent(traceparent)) return traceparent
  }
  return storedTraceparent()
}

/** Trace ids for crash dumps (#791). Null when this tab has no trace yet. */
export function currentTraceIds(): { traceId: string; spanId: string } | null {
  return traceIdsFromTraceparent(activeTraceparent())
}

/**
 * PWA → HTTP hop. Adds a child `traceparent` to outgoing request headers and
 * remembers it so a crash dump joins to the same trace.
 */
export function traceHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const next = wireTraceHeaders(headers, activeTraceparent() ?? undefined)
  rememberTrace(next.traceparent)
  return next
}

/** Main thread → worker hop (#791). */
export function wrapForWorker<T extends Record<string, unknown>>(message: T): T & Record<string, unknown> {
  return wireWrapForWorker(message, activeTraceparent() ?? undefined) as T & Record<string, unknown>
}

/** Worker → main-thread hop (#791): records the worker span as a link. */
export function unwrapFromWorker<T extends Record<string, unknown>>(message: T): {
  message: T
  trace: { v: number; traceId: string; spanId: string; traceparent: string; links: Array<{ traceId: string; spanId: string }> } | null
} {
  return wireUnwrapFromWorker(message) as {
    message: T
    trace: { v: number; traceId: string; spanId: string; traceparent: string; links: Array<{ traceId: string; spanId: string }> } | null
  }
}

export interface ErrorContext {
  source: string;
  component?: string;
  traceId?: string;
  userId?: string;
  [key: string]: unknown;
}

/**
 * Record an error with OTel context (Issue #746)
 */
export function recordError(error: Error, ctx: ErrorContext = { source: 'unknown' }): void {
  const span = tracer.startSpan('error.record');

  try {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });

    // Add context attributes
    Object.entries(ctx).forEach(([key, value]) => {
      span.setAttribute(key, String(value));
    });

    // Store trace + span ids for linking crash dumps and later hops (#791)
    rememberTrace(traceparentFromSpanContext(span.spanContext()));
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) rememberTrace(traceparentFromSpanContext(activeSpan.spanContext()));
  } finally {
    span.end();
  }
}

/**
 * Link an error to an existing trace (Issue #746)
 */
export function linkError(error: Error, traceId: string): void {
  const span = tracer.startSpan('error.link');

  try {
    span.setAttribute('error.trace_id', traceId);
    span.setAttribute('error.message', error.message);
    span.recordException(error);
  } finally {
    span.end();
  }
}

/**
 * Track GraphQL subscription transport (Issue #754)
 */
export function trackSubscriptionTransport(
  transport: 'ws' | 'http2_push' | 'redis_pubsub',
  operation: string,
  duration: number,
  success: boolean
): void {
  const span = tracer.startSpan('subscription.transport');

  try {
    span.setAttributes({
      'subscription.transport': transport,
      'subscription.operation': operation,
      'subscription.duration_ms': duration,
      'subscription.success': success,
    });

    if (!success) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
  } finally {
    span.end();
  }
}

/**
 * Track whether an emergency audio alert was actually audible (ISP-049).
 * `blocked` means the browser's autoplay policy kept the AudioContext
 * suspended, so the siren could not sound; `fallback` records what was done
 * instead. blocked / (played + blocked) is the "audio-blocked rate".
 */
export function trackAudioAlert(
  outcome: 'played' | 'blocked',
  details: { fallback?: 'vibrate' | 'none' } = {}
): void {
  const span = tracer.startSpan('audio.alert');

  try {
    span.setAttributes({
      'audio.outcome': outcome,
      'audio.fallback': details.fallback ?? 'none',
    });

    if (outcome === 'blocked') {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'autoplay blocked' });
    }
  } finally {
    span.end();
  }
}

export const MAX_LONGTASK_NAME_LENGTH = 64;
export const MAX_LONGTASK_TELEMETRY_EVENTS = 50;

export interface LongTaskTelemetryEvent {
  name: string;
  durationMs: number;
  startTime: number;
  endTime: number;
  severity: 'warning' | 'critical';
  warningThresholdMs: number;
  criticalThresholdMs: number;
  route?: string;
}

const longTaskTelemetryBuffer: LongTaskTelemetryEvent[] = [];

/**
 * Record a bounded long-task telemetry breach event (#961).
 * Bounds string lengths and retains at most MAX_LONGTASK_TELEMETRY_EVENTS entries.
 */
export function trackLongTask(
  input: {
    name: string;
    durationMs: number;
    startTime: number;
    endTime?: number;
    severity: 'warning' | 'critical';
    warningThresholdMs: number;
    criticalThresholdMs: number;
    route?: string;
  },
  pipeline?: TelemetryPipeline | null,
): LongTaskTelemetryEvent {
  const boundedName = String(input.name || 'longtask').slice(0, MAX_LONGTASK_NAME_LENGTH);
  const durationMs = Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs * 100) / 100) : 0;
  const startTime = Number.isFinite(input.startTime) ? Math.max(0, Math.round(input.startTime * 100) / 100) : 0;
  const endTime = Number.isFinite(input.endTime)
    ? Math.max(startTime, Math.round((input.endTime as number) * 100) / 100)
    : Math.round((startTime + durationMs) * 100) / 100;
  const boundedRoute = input.route ? String(input.route).slice(0, 64) : undefined;

  const event: LongTaskTelemetryEvent = {
    name: boundedName,
    durationMs,
    startTime,
    endTime,
    severity: input.severity,
    warningThresholdMs: input.warningThresholdMs,
    criticalThresholdMs: input.criticalThresholdMs,
    ...(boundedRoute ? { route: boundedRoute } : {}),
  };

  if (input.severity === 'critical') {
    longTaskTelemetryBuffer.push(event);
    while (longTaskTelemetryBuffer.length > MAX_LONGTASK_TELEMETRY_EVENTS) {
      longTaskTelemetryBuffer.shift();
    }
  }

  const span = tracer.startSpan('longtask.breach');
  try {
    span.setAttributes({
      'longtask.name': event.name,
      'longtask.duration_ms': event.durationMs,
      'longtask.severity': event.severity,
      'longtask.warning_threshold_ms': event.warningThresholdMs,
      'longtask.critical_threshold_ms': event.criticalThresholdMs,
      ...(event.route ? { 'longtask.route': event.route } : {}),
    });
    if (event.severity === 'critical') {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'critical long task' });
    }
  } finally {
    span.end();
  }

  if (pipeline) {
    pipeline.record({
      name: 'longtask.breach',
      kind: 'longtask',
      priority: event.severity === 'critical' ? 'critical' : 'normal',
      ts: event.startTime,
      durationMs: event.durationMs,
      attributes: {
        taskName: event.name,
        severity: event.severity,
        warningThresholdMs: event.warningThresholdMs,
        criticalThresholdMs: event.criticalThresholdMs,
        ...(event.route ? { route: event.route } : {}),
      },
    });
  }

  return event;
}

export function getLongTaskTelemetryEvents(): LongTaskTelemetryEvent[] {
  return [...longTaskTelemetryBuffer];
}

export function clearLongTaskTelemetryEvents(): void {
  longTaskTelemetryBuffer.length = 0;
}

/**
 * Track video performance metrics (Issue #745)
 */
export function trackVideoPerformance(
  metric: 'forward_play' | 'reverse_play' | 'frame_drop' | 'raf_throttle',
  duration: number
): void {
  const span = tracer.startSpan('video.performance');

  try {
    span.setAttributes({
      'video.metric': metric,
      'video.duration_ms': duration,
    });
  } finally {
    span.end();
  }
}

/**
 * Track Soroban state operations (Issue #755)
 */
export function trackSorobanState(
  operation: 'read' | 'write' | 'delete',
  size: number,
  duration: number
): void {
  const span = tracer.startSpan('soroban.state');

  try {
    span.setAttributes({
      'soroban.operation': operation,
      'soroban.state_size_bytes': size,
      'soroban.duration_ms': duration,
    });
  } finally {
    span.end();
  }
}

/**
 * Start a blob-worker operation trace (Issue #746)
 */
export function startBlobWorkerTrace(operationId: string): () => void {
  const span = tracer.startSpan('blob_worker.operation', {
    attributes: {
      'blob_worker.operation_id': operationId,
    },
  });

  // Store operation ID for error linkage
  const operationIds = JSON.parse(sessionStorage.getItem('blob_worker_ops') || '[]');
  operationIds.push({ id: operationId, timestamp: Date.now() });
  // Keep only last 10 operations
  sessionStorage.setItem('blob_worker_ops', JSON.stringify(operationIds.slice(-10)));

  return () => {
    span.end();
  };
}

export default TelemetryPipeline;

// ---------------------------------------------------------------------------
// Binary map-frame WebSocket client (ADR-014 follow-up 2, this PR).
// Low-rate APIs stay JSON; high-rate positions arrive as HPTL FlatBuffers.
// ---------------------------------------------------------------------------

export interface TelemetryConfig {
  transport: string
  endpoint: string
  binaryType: 'arraybuffer'
  fileIdentifier: string
  maxObjectsPerFrame: number
  maxFrameBytes: number
  maxFramesPerSecond: number
  maxClients: number
}

export interface TelemetryClientOptions {
  url: string
  onFrame?: (frame: MapFrame) => void
  onJson?: (message: unknown) => void
  onDropped?: (reason: string) => void
  onError?: (error: unknown) => void
  /** Injected for tests; defaults to the global WebSocket constructor. */
  WebSocketImpl?: typeof WebSocket
}

export interface TelemetryClient {
  close: () => void
  readonly socket: WebSocket | null
}

export const DEFAULT_FRAME_STREAM = '/api/events/frame-stream'

/** Open the binary frame stream; malformed frames are dropped, never thrown. */
export function createTelemetryClient(options: TelemetryClientOptions): TelemetryClient {
  const Impl = options.WebSocketImpl ?? (typeof WebSocket !== 'undefined' ? WebSocket : null)
  if (!Impl) return { close: () => {}, socket: null }

  const socket = new Impl(options.url)
  socket.binaryType = 'arraybuffer'

  socket.onmessage = (event: MessageEvent) => {
    const data = event.data
    if (data instanceof ArrayBuffer) {
      const result = verifyFrame(new Uint8Array(data))
      if (!result.ok) {
        options.onDropped?.(result.error ?? 'malformed frame')
        return
      }
      options.onFrame?.(result.frame as MapFrame)
      return
    }
    if (ArrayBuffer.isView(data)) {
      const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      const result = verifyFrame(view)
      if (!result.ok) options.onDropped?.(result.error ?? 'malformed frame')
      else options.onFrame?.(result.frame as MapFrame)
      return
    }
    try {
      options.onJson?.(JSON.parse(String(data)))
    } catch {
      options.onDropped?.('unparseable JSON control message')
    }
  }
  socket.onerror = (error) => options.onError?.(error)

  return { socket, close: () => socket.close() }
}

/** Fetch the JSON discovery/config document. */
export async function fetchTelemetryConfig(baseUrl = ''): Promise<TelemetryConfig> {
  const response = await fetch(`${baseUrl}/api/events/frames/config`, {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`telemetry config failed: ${response.status}`)
  return (await response.json()) as TelemetryConfig
}

/** HTTP ingest fallback for clients without WebSocket support. */
export async function postTelemetryFrame(frame: Uint8Array, baseUrl = ''): Promise<boolean> {
  const response = await fetch(`${baseUrl}/api/events/frames`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: frame as unknown as BodyInit,
  })
  return response.status === 202
}
