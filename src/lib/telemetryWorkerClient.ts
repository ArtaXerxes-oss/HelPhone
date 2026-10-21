/**
 * Main-thread ingest client for the telemetry worker.
 *
 * Responsibilities:
 *  - Transfer raw ArrayBuffers to the worker (zero-copy ownership handoff).
 *  - Mirror ring pressure to the worker immediately (<200ms), so the worker
 *    stops parsing non-critical batches before its queue grows.
 *  - Fall back to main-thread parsing when workers are unavailable/corrupt.
 *  - Keep raw-frame accounting truthful: every ingested frame ends up parsed,
 *    sampled, shed, or queue-dropped with an explicit reason.
 */

import { TelemetryPipeline, type TelemetrySpanInput } from './telemetry';
import type { TelemetryPriority } from './ringBuffer';

export interface TelemetryWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface ParsedFrame {
  priority?: TelemetryPriority;
  kindName?: string;
  ts?: number;
  seq?: number;
  lat?: number;
  lng?: number;
  accuracy?: number;
  error?: string;
}

export interface TelemetryIngestOptions {
  pipeline: TelemetryPipeline;
  workerFactory?: () => TelemetryWorkerLike;
  parser?: { parseBatch(input: ArrayBuffer | ArrayBufferView, count?: number, options?: unknown): ParsedFrame[] };
  now?: () => number;
  workerTimeoutMs?: number;
}

export interface IngestStats {
  framesIngested: number;
  framesParsed: number;
  framesShed: number;
  parseErrors: number;
  pending: number;
  workerMode: 'worker' | 'main-thread';
  pipeline: ReturnType<TelemetryPipeline['snapshot']>;
}

export class TelemetryIngestClient {
  private readonly pipeline: TelemetryPipeline;
  private readonly workerFactory?: () => TelemetryWorkerLike;
  private readonly parser?: TelemetryIngestOptions['parser'];
  private readonly now: () => number;
  private worker: TelemetryWorkerLike | null = null;
  private workerMode: 'worker' | 'main-thread' = 'main-thread';
  private nextId = 1;
  private framesIngested = 0;
  private framesParsed = 0;
  private framesShed = 0;
  private parseErrors = 0;
  private readonly pending = new Map<number, { count: number; priority: TelemetryPriority }>();
  private unsubscribePressure: (() => void) | null = null;
  private stopped = false;

  constructor(options: TelemetryIngestOptions) {
    this.pipeline = options.pipeline;
    this.workerFactory = options.workerFactory;
    this.parser = options.parser;
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    if (this.worker || this.stopped) return;
    if (!this.workerFactory || typeof Worker === 'undefined') return;
    try {
      const worker = this.workerFactory();
      worker.onmessage = (event) => this.handleWorkerMessage(event.data);
      worker.onerror = () => {
        // A crashed worker must not take ingestion down. Fall back in place;
        // pending frames are accounted as parse errors.
        this.failPending('worker_error');
        this.worker = null;
        this.workerMode = 'main-thread';
      };
      worker.postMessage({ type: 'telemetry:init' });
      this.worker = worker;
      this.workerMode = 'worker';
      this.unsubscribePressure = this.pipeline.onPressure((event) => {
        const level = event.level === 'critical' ? 2 : event.level === 'high' ? 1 : 0;
        try {
          worker.postMessage({ type: 'telemetry:congestion', level, occupancy: event.occupancy });
        } catch {
          // Worker may be terminating; the ring still sheds locally.
        }
      });
    } catch {
      this.worker = null;
      this.workerMode = 'main-thread';
    }
  }

  /** Ingest `count` contiguous binary frames. Takes ownership of `buffer`. */
  ingest(buffer: ArrayBuffer, count: number, priority: TelemetryPriority = 'normal'): number {
    if (this.stopped || count <= 0) return -1;
    this.framesIngested += count;

    // Critical ring pressure: shed non-critical batches on the main thread
    // before they ever reach the worker. This is the <200ms response path.
    if (this.pipeline.ring.pressureLevel === 'critical' && priority !== 'critical') {
      this.pipeline.recordDropped('backpressure', count);
      this.framesShed += count;
      return -1;
    }

    if (this.worker) {
      const id = this.nextId++;
      this.pending.set(id, { count, priority });
      try {
        this.worker.postMessage(
          { type: 'telemetry:parse', id, buffer, count, priority },
          [buffer],
        );
        return id;
      } catch {
        this.pending.delete(id);
        // Transfer failed (buffer detached); fall through to local parse.
      }
    }

    this.parseLocally(buffer, count, priority);
    return -1;
  }

  handleWorkerMessage(message: unknown): void {
    const msg = message as {
      type?: string;
      id?: number;
      frames?: ParsedFrame[];
      shed?: number;
      count?: number;
      reason?: string;
      message?: string;
    };
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'telemetry:parsed') {
      this.pending.delete(msg.id ?? -1);
      this.admitFrames(msg.frames ?? []);
      if (msg.shed && msg.shed > 0) {
        this.pipeline.recordDropped('backpressure', msg.shed);
        this.framesShed += msg.shed;
      }
      return;
    }

    if (msg.type === 'telemetry:shed') {
      this.pending.delete(msg.id ?? -1);
      const count = msg.count ?? 1;
      this.pipeline.recordDropped('backpressure', count);
      this.framesShed += count;
      return;
    }

    if (msg.type === 'telemetry:error') {
      const entry = this.pending.get(msg.id ?? -1);
      this.pending.delete(msg.id ?? -1);
      if (entry) {
        this.pipeline.recordDropped('parse_error', entry.count);
        this.parseErrors += entry.count;
      }
    }
  }

  flush() {
    return this.pipeline.flush();
  }

  snapshot(): IngestStats {
    return {
      framesIngested: this.framesIngested,
      framesParsed: this.framesParsed,
      framesShed: this.framesShed,
      parseErrors: this.parseErrors,
      pending: this.pending.size,
      workerMode: this.workerMode,
      pipeline: this.pipeline.snapshot(),
    };
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribePressure?.();
    this.unsubscribePressure = null;
    this.failPending('stopped');
    try {
      this.worker?.terminate();
    } catch {
      // ignore
    }
    this.worker = null;
    this.workerMode = 'main-thread';
  }

  private parseLocally(buffer: ArrayBuffer, count: number, priority: TelemetryPriority): void {
    if (!this.parser) {
      this.pipeline.recordDropped('parse_error', count);
      this.parseErrors += count;
      return;
    }
    try {
      const frames = this.parser.parseBatch(buffer, count, { stopOnError: false });
      this.admitFrames(frames);
    } catch {
      this.pipeline.recordDropped('parse_error', count);
      this.parseErrors += count;
    }
    void priority;
  }

  private admitFrames(frames: ParsedFrame[]): void {
    let admitted = 0;
    let errors = 0;
    for (const frame of frames) {
      if (frame?.error) {
        errors++;
        continue;
      }
      const span: TelemetrySpanInput = {
        name: 'telemetry.frame',
        priority: frame.priority ?? 'normal',
        kind: frame.kindName ?? 'unknown',
        ts: Number.isFinite(frame.ts) ? (frame.ts as number) : this.now(),
        attributes: {
          seq: frame.seq,
          lat: frame.lat,
          lng: frame.lng,
          accuracy: frame.accuracy,
        },
      };
      if (this.pipeline.record(span)) admitted++;
    }
    this.framesParsed += admitted;
    if (errors > 0) {
      this.pipeline.recordDropped('parse_error', errors);
      this.parseErrors += errors;
    }
  }

  private failPending(reason: string): void {
    let count = 0;
    for (const entry of this.pending.values()) count += entry.count;
    this.pending.clear();
    if (count > 0) {
      this.pipeline.recordDropped('parse_error', count);
      this.parseErrors += count;
      void reason;
    }
  }
}

export default TelemetryIngestClient;
