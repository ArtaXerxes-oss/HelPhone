/**
 * TelemetryLab controller: a deterministic, browser-safe harness for the
 * pipeline. It generates binary frames at a configurable rate, feeds them
 * through the worker (or main-thread fallback), and exposes one truthful
 * snapshot per second.
 */

import { TelemetryPipeline, createMemoryExporter, type TelemetrySnapshot } from './telemetry';
import { TelemetryIngestClient } from './telemetryWorkerClient';
import { TelemetryWasmParser } from '../utils/binaryParserWasm';
import { encodeFrame, FRAME_KIND } from '../utils/binaryParser';
import { profileFor, type NetworkClass } from './networkEstimator';
import { FRAME_BYTES } from '../utils/binaryParser';

export interface LabSnapshot extends TelemetrySnapshot {
  lab: {
    running: boolean;
    rateHz: number;
    framesIngested: number;
    framesShed: number;
    parseErrors: number;
    workerMode: string;
    collectorDown: boolean;
  };
}

export interface LabOptions {
  capacity?: number;
  rateHz?: number;
  useWorker?: boolean;
}

export class TelemetryLabController {
  readonly pipeline: TelemetryPipeline;
  readonly exporter: ReturnType<typeof createMemoryExporter>;
  readonly ingest: TelemetryIngestClient;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private rateHz: number;
  private seq = 0;
  private collectorDown = false;
  private readonly timers: { set?: typeof setInterval; clear?: typeof clearInterval };

  constructor(options: LabOptions = {}) {
    this.rateHz = options.rateHz ?? 500;
    this.exporter = createMemoryExporter({ maxBatches: 40 });
    this.pipeline = new TelemetryPipeline({
      capacity: options.capacity ?? 512,
      networkClass: '4g',
      exporter: this.exporter,
      ring: { highWatermark: 0.7, shedWatermark: 0.9, lowWatermark: 0.5 },
    });

    const preferWorker = options.useWorker ?? typeof Worker !== 'undefined';
    this.ingest = new TelemetryIngestClient({
      pipeline: this.pipeline,
      parser: new TelemetryWasmParser({ preferWasm: true }),
      workerFactory: preferWorker
        ? () =>
            new Worker(new URL('../workers/telemetryWorker.js', import.meta.url), {
              type: 'module',
            })
        : undefined,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.ingest.start();
    // 20 ticks/s keeps the generator cheap while still producing 500 msg/s at
    // the default rate; each tick emits exactly rateHz/20 frames.
    this.timer = setInterval(() => this.emitTick(), 50);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setRate(rateHz: number): void {
    this.rateHz = Math.max(1, Math.min(10_000, Math.floor(rateHz)));
  }

  setNetwork(networkClass: NetworkClass): void {
    this.pipeline.setNetworkClass(networkClass);
  }

  setCollectorDown(down: boolean): void {
    this.collectorDown = down;
    this.pipeline.setExporter(
      down
        ? {
            async export() {
              const error = new Error('collector unavailable') as Error & { retryAfterMs?: number };
              error.retryAfterMs = 2_000;
              throw error;
            },
          }
        : this.exporter,
    );
  }

  async flush(): Promise<void> {
    await this.pipeline.flush();
  }

  snapshot(): LabSnapshot {
    const pipeline = this.pipeline.snapshot();
    const ingest = this.ingest.snapshot();
    return {
      ...pipeline,
      lab: {
        running: this.running,
        rateHz: this.rateHz,
        framesIngested: ingest.framesIngested,
        framesShed: ingest.framesShed,
        parseErrors: ingest.parseErrors,
        workerMode: ingest.workerMode,
        collectorDown: this.collectorDown,
      },
    };
  }

  destroy(): void {
    this.stop();
    this.ingest.stop();
    this.pipeline.stop();
  }

  private emitTick(): void {
    const perTick = Math.max(1, Math.round(this.rateHz / 20));
    const buffer = new ArrayBuffer(perTick * FRAME_BYTES);
    const bytes = new Uint8Array(buffer);
    let critical = 0;
    for (let i = 0; i < perTick; i++) {
      const seq = this.seq++;
      const roll = seq % 10;
      const kind = roll === 0 ? FRAME_KIND.DISPATCH_ACK : roll < 3 ? FRAME_KIND.HEARTBEAT : FRAME_KIND.LOCATION;
      if (kind === FRAME_KIND.DISPATCH_ACK) critical++;
      const frame = encodeFrame({
        kind,
        priority: kind === FRAME_KIND.DISPATCH_ACK ? 2 : kind === FRAME_KIND.HEARTBEAT ? 0 : 1,
        seq,
        ts: Date.now(),
        lat: 6.5 + (seq % 1_000) * 1e-5,
        lng: 3.3 + (seq % 1_000) * 1e-5,
        accuracy: 3 + (seq % 20),
      });
      bytes.set(new Uint8Array(frame), i * FRAME_BYTES);
    }
    this.ingest.ingest(buffer, perTick, critical === perTick ? 'critical' : 'normal');
  }
}

let singleton: TelemetryLabController | null = null;

export function getTelemetryLabController(options?: LabOptions): TelemetryLabController {
  if (!singleton) singleton = new TelemetryLabController(options);
  return singleton;
}

export function resetTelemetryLabController(): void {
  singleton?.destroy();
  singleton = null;
}

export function labProfile(networkClass: NetworkClass) {
  return profileFor(networkClass);
}
