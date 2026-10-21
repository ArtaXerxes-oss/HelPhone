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
