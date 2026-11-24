/**
 * Worker-side telemetry parsing protocol with explicit flow control.
 *
 * Main thread → worker:
 *   { type: 'telemetry:init' }
 *   { type: 'telemetry:parse', id, buffer, count, priority }
 *   { type: 'telemetry:congestion', level: 0|1|2, occupancy }
 *   { type: 'telemetry:stats', id }
 *
 * Worker → main thread:
 *   { type: 'telemetry:ready', mode }
 *   { type: 'telemetry:parsed', id, frames, stats }
 *   { type: 'telemetry:shed', id, count, reason }
 *   { type: 'telemetry:error', id?, message }
 *
 * When the ring signals critical occupancy (level 2), non-critical batches are
 * shed without parsing, and the queue is bounded with drop-oldest accounting.
 * This is what keeps low-end Android tabs from growing an unbounded worker
 * queue when the map is animating at 60fps.
 */

import { TelemetryWasmParser } from '../utils/binaryParserWasm.js';

export function createTelemetryWorkerProtocol(options = {}) {
  const postMessage = options.postMessage ?? ((message) => self.postMessage(message));
  const parser = options.parser ?? new TelemetryWasmParser(options.parserOptions);
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const config = {
    maxQueue: options.maxQueue ?? 64,
    lowResLevel: options.lowResLevel ?? 1,
    pauseLevel: options.pauseLevel ?? 2,
  };

  let congestion = 0;
  let paused = false;
  let lowRes = false;
  let stopped = false;
  let draining = false;
  let ready = false;

  const queue = [];
  const stats = {
    received: 0,
    parsed: 0,
    shed: 0,
    errors: 0,
    backpressure: 0,
    queueDrops: 0,
    maxQueueDepth: 0,
    parseMs: 0,
  };

  parser.init?.().then(
    () => {
      ready = true;
      postMessage({ type: 'telemetry:ready', mode: parser.mode, stats: snapshot() });
    },
    (error) => {
      // JS fallback remains active; report but do not fail the worker.
      ready = true;
      postMessage({ type: 'telemetry:ready', mode: 'js', error: String(error?.message || error) });
    },
  );

  function snapshot() {
    return {
      ...stats,
      mode: parser.mode,
      ready: parser.ready,
      congestion,
      paused,
      lowRes,
      queueDepth: queue.length,
    };
  }

  function enqueue(message) {
    if (queue.length >= config.maxQueue) {
      // Drop oldest, count it, then admit the newest. Never let the queue grow.
      const dropped = queue.shift();
      stats.queueDrops++;
      stats.shed++;
      postMessage({
        type: 'telemetry:shed',
        id: dropped?.id ?? null,
        count: dropped?.count ?? 1,
        reason: 'worker_queue_overflow',
      });
    }
    queue.push(message);
    stats.maxQueueDepth = Math.max(stats.maxQueueDepth, queue.length);
    void drain();
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && !stopped) {
        // Yield once per batch so messages that arrived in the same tick are
        // visible to the bounded queue (and to the congestion check).
        await Promise.resolve();
        const message = queue.shift();
        const batchPriority = message.priority ?? 'normal';

        // 90%+ ring occupancy: only dispatch-critical batches may proceed.
        if (paused && batchPriority !== 'critical') {
          stats.shed += message.count ?? 1;
          stats.backpressure++;
          postMessage({
            type: 'telemetry:shed',
            id: message.id,
            count: message.count ?? 1,
            reason: 'backpressure',
          });
          continue;
        }

        const started = now();
        try {
          // `reuse` pools frame objects; postMessage clones them synchronously
          // before the next batch can mutate the pool.
          const frames = parser.parseBatch(message.buffer, message.count, { stopOnError: false, reuse: true, reuseArray: true });
          stats.parsed += frames.length;
          stats.parseMs += now() - started;

          // Low-res mode: drop heartbeat frames before they cross the worker
          // boundary. Normal + critical frames still flow.
          const filtered =
            lowRes && batchPriority !== 'critical'
              ? frames.filter((frame) => frame.priority !== 'heartbeat' || frame.error)
              : frames;
          if (filtered.length !== frames.length) {
            stats.shed += frames.length - filtered.length;
            stats.backpressure += frames.length - filtered.length;
          }

          postMessage({
            type: 'telemetry:parsed',
            id: message.id,
            frames: filtered,
            shed: frames.length - filtered.length,
            stats: snapshot(),
          });
        } catch (error) {
          stats.errors++;
          postMessage({
            type: 'telemetry:error',
            id: message.id,
            message: String(error?.message || error),
          });
        }
      }
    } finally {
      draining = false;
    }
  }

  function handle(message) {
    if (!message || typeof message.type !== 'string') return false;
    if (!message.type.startsWith('telemetry:')) return false;

    switch (message.type) {
      case 'telemetry:init':
        postMessage({ type: 'telemetry:ready', mode: parser.mode, stats: snapshot() });
        return true;

      case 'telemetry:parse':
        stats.received += message.count ?? 1;
        enqueue(message);
        return true;

      case 'telemetry:congestion': {
        const level = Math.max(0, Math.min(2, Number(message.level) || 0));
        congestion = level;
        // Hysteresis is owned by the ring: it only emits transitions.
        paused = level >= config.pauseLevel;
        lowRes = level >= config.lowResLevel;
        if (level === 0 && queue.length > 0) void drain();
        return true;
      }

      case 'telemetry:stats':
        postMessage({ type: 'telemetry:stats', id: message.id, stats: snapshot() });
        return true;

      case 'telemetry:stop':
        stopped = true;
        queue.length = 0;
        return true;

      default:
        return false;
    }
  }

  return {
    handle,
    snapshot,
    get queueDepth() {
      return queue.length;
    },
    get paused() {
      return paused;
    },
    get congestion() {
      return congestion;
    },
  };
}

export default createTelemetryWorkerProtocol;
