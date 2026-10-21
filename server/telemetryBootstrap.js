/**
 * Server telemetry bootstrap.
 *
 * Wires the bounded receiver into Express and exposes the same counters as
 * the client pipeline. Also initializes OpenTelemetry Node SDK if configured.
 */

import {
  TelemetryReceiver,
  createOtlpExporter,
  normalizeSpans,
  initializeTelemetry,
  shutdownTelemetry as shutdownOtelSdk,
} from './telemetry.js';

// Auto-initialize OpenTelemetry SDK
initializeTelemetry();

let receiver = null;
let installed = false;

export function createTelemetryReceiverFromEnv(env = process.env) {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const exporter = endpoint
    ? createOtlpExporter({
        endpoint: endpoint.includes('/v1/traces') ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/traces`,
        fetchImpl: env.TELEMETRY_FETCH_IMPL || globalThis.fetch,
      })
    : null;

  const instance = new TelemetryReceiver({
    maxQueueSize: Number(env.TELEMETRY_MAX_QUEUE || 1_000),
    maxBatchSize: Number(env.TELEMETRY_MAX_BATCH || 100),
    flushIntervalMs: Number(env.TELEMETRY_FLUSH_MS || 1_000),
    retryAfterMs: Number(env.TELEMETRY_RETRY_AFTER_MS || 2_000),
    exporter,
  });
  instance.start();
  return instance;
}

export function getTelemetryReceiver(env = process.env) {
  if (!receiver) receiver = createTelemetryReceiverFromEnv(env);
  return receiver;
}

export function setTelemetryReceiver(instance) {
  receiver = instance;
}

/** Express handler for POST /api/telemetry/spans. */
export function telemetryIngestHandler(req, res) {
  const instance = getTelemetryReceiver();
  const spans = normalizeSpans(req.body);
  const result = instance.ingest(spans);

  res.set('Cache-Control', 'no-store');
  if (result.retryAfter) res.set('Retry-After', String(result.retryAfter));
  if (result.status === 503) res.set('X-Telemetry-Backpressure', 'collector-unavailable');
  else if (result.status === 429) res.set('X-Telemetry-Backpressure', 'queue-high-watermark');

  res.status(result.status).json({
    accepted: result.accepted,
    dropped: result.dropped,
    queueDepth: instance.queue.length,
    retryAfter: result.retryAfter,
    status: result.status === 202 ? 'accepted' : 'shed',
  });
}

export function telemetryMetricsHandler(_req, res) {
  res.set('Cache-Control', 'no-store').json(getTelemetryReceiver().snapshot());
}

/**
 * Mount telemetry routes once. Returns false when already installed so a
 * double import cannot double-register handlers (and double count).
 */
export function installTelemetryRoutes(app) {
  if (installed) return false;
  installed = true;
  app.post('/api/telemetry/spans', telemetryIngestHandler);
  app.get('/metrics/telemetry', telemetryMetricsHandler);
  return true;
}

export async function shutdownTelemetry() {
  if (receiver) {
    receiver.stop();
    await receiver.flush().catch(() => {});
    receiver = null;
    installed = false;
  }
  if (typeof shutdownOtelSdk === 'function') {
    await shutdownOtelSdk().catch(() => {});
  }
}

export function resetTelemetryBootstrapForTests() {
  if (receiver) receiver.stop();
  receiver = null;
  installed = false;
}
