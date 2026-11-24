// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RingBuffer } from '../src/lib/ringBuffer.ts';
import {
  TelemetryPipeline,
  createMemoryExporter,
  shouldSample,
  samplingRate,
} from '../src/lib/telemetry.ts';
import { profileFor } from '../src/lib/networkEstimator.ts';
import { encodeFrame, parseFrame, FRAME_KIND } from '../src/utils/binaryParser.js';
import { TelemetryWasmParser } from '../src/utils/binaryParserWasm.js';
import { createTelemetryWorkerProtocol } from '../src/lib/telemetryWorkerProtocol.js';

const frame = (seq, priority = 'normal', kind = 'location') => ({
  seq,
  priority,
  kind,
  ts: 1_700_000_000_000 + seq,
  payload: { seq },
});

describe('RingBuffer priority + accounting', () => {
  it('evicts heartbeat before normal and normal before critical', () => {
    const ring = new RingBuffer({ capacity: 3 });
    expect(ring.push(frame(1, 'heartbeat'))).toBe(true);
    expect(ring.push(frame(2, 'normal'))).toBe(true);
    expect(ring.push(frame(3, 'critical'))).toBe(true);

    // A new heartbeat must displace the existing heartbeat, never the critical.
    expect(ring.push(frame(4, 'heartbeat'))).toBe(true);
    expect(ring.snapshot().droppedReasons.overflow_heartbeat).toBe(1);
    expect(ring.snapshot().droppedReasons.overflow_critical).toBe(0);

    // The next critical still finds the newest heartbeat and evicts it; only
    // after all heartbeats are gone does it touch the normal frame.
    expect(ring.push(frame(5, 'critical'))).toBe(true);
    expect(ring.snapshot().droppedReasons.overflow_heartbeat).toBe(2);
    expect(ring.push(frame(6, 'critical'))).toBe(true);
    expect(ring.snapshot().droppedReasons.overflow_normal).toBe(1);

    const snapshot = ring.snapshot();
    expect(snapshot.conservation.ok).toBe(true);
    expect(snapshot.size).toBe(3);
  });

  it('rejects an incoming lower-priority frame when the ring is all critical', () => {
    const ring = new RingBuffer({ capacity: 2 });
    ring.push(frame(1, 'critical'));
    ring.push(frame(2, 'critical'));
    expect(ring.push(frame(3, 'heartbeat'))).toBe(false);
    const snapshot = ring.snapshot();
    expect(snapshot.rejected).toBe(1);
    expect(snapshot.evicted).toBe(0);
    expect(snapshot.droppedReasons.overflow_heartbeat).toBe(1);
    expect(snapshot.conservation.ok).toBe(true);
  });

  it('reports pressure with 70/90/50 hysteresis', () => {
    const ring = new RingBuffer({ capacity: 10 });
    const events = [];
    ring.onPressure((event) => events.push(event.level));
    for (let i = 0; i < 7; i++) ring.push(frame(i));
    for (let i = 7; i < 9; i++) ring.push(frame(i));
    ring.drain(5); // occupancy 40% -> normal
    expect(events).toEqual(['high', 'critical', 'normal']);
  });

  it('keeps the conservation invariant under random admission/drain', () => {
    const ring = new RingBuffer({ capacity: 16 });
    for (let i = 0; i < 2_000; i++) {
      ring.push(frame(i, i % 7 === 0 ? 'critical' : i % 3 === 0 ? 'heartbeat' : 'normal'));
      if (i % 5 === 0) ring.drain(3);
      expect(ring.snapshot().conservation.ok).toBe(true);
    }
  });
});

describe('adaptive sampling', () => {
  it('is deterministic per sequence', () => {
    expect(shouldSample(1, 0)).toBe(false);
    expect(shouldSample(1, 1)).toBe(true);
    expect(shouldSample(42, 0.4)).toBe(shouldSample(42, 0.4));
  });

  it('keeps 100% of dispatch-critical spans on 2G while exporting ≤20% of baseline', async () => {
    const exporter = createMemoryExporter();
    const pipeline = new TelemetryPipeline({
      capacity: 8_192,
      networkClass: '2g',
      exporter,
    });

    const critical = 100;
    const normal = 8_000;
    const heartbeat = 2_000;
    for (let i = 0; i < critical; i++) pipeline.record({ name: 'dispatch', priority: 'critical' });
    for (let i = 0; i < normal; i++) pipeline.record({ name: 'map', priority: 'normal' });
    for (let i = 0; i < heartbeat; i++) pipeline.record({ name: 'beacon', priority: 'heartbeat' });

    const exportedCritical = exporter.batches.flat().filter((span) => span.priority === 'critical').length;
    // Flush everything (2G batch size is 5) and count critical spans.
    for (let i = 0; i < 5_000 && pipeline.ring.length > 0; i++) await pipeline.flush();
    const all = exporter.batches.flat();
    const exportedCriticalAfter = all.filter((span) => span.priority === 'critical').length;

    expect(exportedCritical).toBe(0);
    expect(exportedCriticalAfter).toBe(critical);
    expect(all.length).toBeLessThanOrEqual((critical + normal + heartbeat) * 0.2);
    expect(pipeline.snapshot().conservation.ok).toBe(true);
  });

  it('halves the sampling rate at high pressure', () => {
    const profile = profileFor('3g');
    expect(samplingRate(profile, 'normal', 'normal')).toBe(profile.normalSampleRate);
    expect(samplingRate(profile, 'high', 'normal')).toBe(profile.normalSampleRate * 0.5);
    expect(samplingRate(profile, 'critical', 'critical')).toBe(1);
  });
});

describe('export/offline accounting', () => {
  it('diverts offline spans to the durable outbox, not memory', async () => {
    const queued = [];
    const exporter = createMemoryExporter();
    const pipeline = new TelemetryPipeline({
      capacity: 64,
      networkClass: 'offline',
      exporter,
      outbox: { async enqueue(spans) { queued.push(...spans); } },
    });
    for (let i = 0; i < 10; i++) pipeline.record({ name: 'map', priority: 'critical' });
    await pipeline.flush();
    expect(exporter.batches).toHaveLength(0);
    expect(queued).toHaveLength(10);
    const snapshot = pipeline.snapshot();
    expect(snapshot.outboxed).toBe(10);
    expect(snapshot.conservation.ok).toBe(true);
  });

  it('counts export failures with an explicit reason and stays bounded', async () => {
    const pipeline = new TelemetryPipeline({
      capacity: 32,
      exporter: {
        async export() {
          const error = new Error('collector down');
          error.retryAfterMs = 1_000;
          throw error;
        },
      },
    });
    for (let i = 0; i < 20; i++) pipeline.record({ name: 'map', priority: 'critical' });
    await pipeline.flush();
    const snapshot = pipeline.snapshot();
    expect(snapshot.exportFailed).toBeGreaterThan(0);
    expect(snapshot.droppedReasons.export_fail).toBe(snapshot.exportFailed);
    expect(snapshot.exporterHealthy).toBe(false);
    expect(snapshot.conservation.ok).toBe(true);
  });
});

describe('binary parser parity', () => {
  it('JS and WASM produce identical frames', async () => {
    const wasmPath = resolve(process.cwd(), 'src/wasm/telemetry_reader.wasm');
    const shaPath = resolve(process.cwd(), 'src/wasm/telemetry_reader.wasm.sha256');
    const parser = new TelemetryWasmParser({
      wasmBytes: readFileSync(wasmPath),
      expectedSha256: readFileSync(shaPath, 'utf8').trim(),
      shaUrl: undefined,
    });
    const ready = await parser.init();
    expect(ready).toBe(true);

    const frames = [
      { seq: 1, kind: FRAME_KIND.LOCATION, ts: 1_700_000_000_000, lat: 6.5, lng: 3.3, accuracy: 4 },
      { seq: 2, kind: FRAME_KIND.DISPATCH_ACK, ts: 1_700_000_000_001, lat: 6.51, lng: 3.31, accuracy: 5 },
      { seq: 3, kind: FRAME_KIND.HEARTBEAT, ts: 1_700_000_000_002, lat: 6.52, lng: 3.32, accuracy: 6 },
    ];
    const buffer = new Uint8Array(frames.length * 40);
    frames.forEach((value, index) => buffer.set(new Uint8Array(encodeFrame(value)), index * 40));

    for (let i = 0; i < frames.length; i++) {
      const js = parseFrame(buffer, i * 40);
      const wasm = parser.parseBatch(buffer, frames.length)[i];
      expect(wasm).toMatchObject({
        seq: js.seq,
        ts: js.ts,
        lat: js.lat,
        lng: js.lng,
        accuracy: js.accuracy,
        kind: js.kind,
        priority: js.priority,
      });
    }
  });
});

describe('worker flow control', () => {
  it('sheds non-critical batches at congestion level 2 and parses critical', async () => {
    const messages = [];
    const parser = {
      mode: 'js',
      ready: true,
      init: async () => true,
      parseBatch: () => [{ priority: 'critical', kindName: 'dispatch_ack', seq: 1, ts: 1 }],
    };
    const protocol = createTelemetryWorkerProtocol({
      postMessage: (message) => messages.push(message),
      parser,
    });

    protocol.handle({ type: 'telemetry:congestion', level: 2 });
    protocol.handle({ type: 'telemetry:parse', id: 1, buffer: new ArrayBuffer(40), count: 1, priority: 'normal' });
    protocol.handle({ type: 'telemetry:parse', id: 2, buffer: new ArrayBuffer(40), count: 1, priority: 'critical' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(messages.some((message) => message.type === 'telemetry:shed' && message.reason === 'backpressure')).toBe(true);
    expect(messages.some((message) => message.type === 'telemetry:parsed' && message.id === 2)).toBe(true);
    expect(messages.some((message) => message.type === 'telemetry:parsed' && message.id === 1)).toBe(false);
  });

  it('bounds the worker queue with drop-oldest accounting', () => {
    const messages = [];
    const parser = {
      mode: 'js',
      ready: true,
      init: async () => true,
      parseBatch: () => [],
    };
    const protocol = createTelemetryWorkerProtocol({
      postMessage: (message) => messages.push(message),
      parser,
      maxQueue: 2,
    });
    for (let i = 0; i < 5; i++) {
      protocol.handle({ type: 'telemetry:parse', id: i, buffer: new ArrayBuffer(40), count: 1 });
    }
    expect(protocol.queueDepth).toBeLessThanOrEqual(2);
    expect(protocol.snapshot().queueDrops).toBeGreaterThan(0);
  });
});
