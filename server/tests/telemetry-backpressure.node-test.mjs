import test from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryReceiver, normalizeSpans } from '../telemetry.js';

function span(i, priority = 'normal') {
  return { name: `span-${i}`, priority, ts: Date.now() + i, attributes: {} };
}

test('bounded queue never exceeds maxQueueSize under a 500 msg/s burst', () => {
  const receiver = new TelemetryReceiver({
    maxQueueSize: 100,
    maxBatchSize: 25,
    exporter: { async export() {} },
  });

  // 500 messages/s for 10 simulated seconds = 5,000 frames.
  for (let i = 0; i < 5_000; i++) {
    receiver.ingest([span(i, i % 20 === 0 ? 'critical' : i % 3 === 0 ? 'heartbeat' : 'normal')]);
    assert.ok(receiver.queue.length <= 100, `queue grew to ${receiver.queue.length}`);
  }

  const snapshot = receiver.snapshot();
  assert.equal(snapshot.dropped, snapshot.rejected + snapshot.evicted);
  assert.ok(snapshot.droppedReasons.overflow_heartbeat > 0);
  assert.equal(snapshot.received, 5_000);
  assert.equal(snapshot.admitted + snapshot.rejected, 5_000);
  assert.equal(snapshot.conservation.ok, true);
  assert.equal(snapshot.queueDepth, 100);
});

test('collector outage returns 503 + Retry-After and bounds the heap queue', async () => {
  let now = 0;
  const receiver = new TelemetryReceiver({
    maxQueueSize: 50,
    now: () => now,
    exporter: {
      async export() {
        const error = new Error('collector down');
        error.retryAfterMs = 5_000;
        throw error;
      },
    },
  });

  for (let i = 0; i < 50; i++) receiver.ingest([span(i)]);
  await receiver.flush();

  const result = receiver.ingest([span(51)]);
  assert.equal(result.status, 503);
  assert.equal(result.retryAfter, 5);

  // Five simulated minutes of outage: the queue stays capped.
  for (let i = 0; i < 10_000; i++) {
    now += 30;
    receiver.ingest([span(i, i % 10 === 0 ? 'critical' : 'normal')]);
  }
  const snapshot = receiver.snapshot();
  assert.ok(snapshot.queueDepth <= 50);
  assert.ok(snapshot.dropped > 0);
  assert.ok(snapshot.droppedReasons.export_fail > 0);
});

test('never drops a critical span before heartbeat/normal spans', async () => {
  const receiver = new TelemetryReceiver({
    maxQueueSize: 3,
    maxBatchSize: 10,
    exporter: { async export() {} },
  });
  receiver.ingest([span(1, 'heartbeat')]);
  receiver.ingest([span(2, 'normal')]);
  receiver.ingest([span(3, 'critical')]);

  receiver.ingest([span(4, 'critical')]);
  receiver.ingest([span(5, 'critical')]);
  receiver.ingest([span(6, 'critical')]);

  const snapshot = receiver.snapshot();
  assert.equal(snapshot.droppedReasons.overflow_heartbeat, 1);
  assert.equal(snapshot.droppedReasons.overflow_normal, 1);
  assert.equal(snapshot.droppedReasons.overflow_critical, 1);
  assert.equal(snapshot.queueDepth, 3);
  assert.equal(receiver.queue.filter((s) => s.priority === 'critical').length, 3);
});

test('normalizes OTLP resourceSpans into receiver spans', () => {
  const spans = normalizeSpans({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                name: 'dispatch.ack',
                startTimeUnixNano: '1700000000000000000',
                attributes: [{ key: 'helphone.priority', value: { stringValue: 'critical' } }],
              },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(spans.length, 1);
  assert.equal(spans[0].priority, 'critical');
  assert.equal(spans[0].ts, 1_700_000_000_000);
});
