import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionAgeDays, planEviction } from '../db/partitionEviction.js';

test('eviction keeps recent and held partitions', () => {
  const now = new Date('2026-11-20T00:00:00Z');
  assert.equal(partitionAgeDays('events_t0_2026_01', now), 323);
  const result = planEviction([
    { name: 'events_t0_2026_01' },
    { name: 'events_t0_2026_10' },
    { name: 'events_t0_2025_12' },
  ], { now, retentionDays: 90, held: new Set(['events_t0_2025_12']) });
  assert.deepEqual(result.map((row) => row.name), ['events_t0_2026_01']);
});
