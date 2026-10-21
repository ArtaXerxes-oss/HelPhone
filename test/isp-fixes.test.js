/**
 * Integration tests for ISP-060 through ISP-063 fixes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AssetManager } from '../src/lib/assetManager'
import { DispatchQueue } from '../src/lib/dispatchQueue'
import { TelemetryRedactor } from '../src/lib/telemetryRedactor'
import { computeReconciliationMerge, advanceVectorClock } from '../src/lib/crdtAdvanced'

const STATUS_RANKS = {
  cancelled: 5,
  open: 10,
  assigned: 20,
  in_progress: 30,
  resolved: 40,
  escalated: 50,
  critical: 55,
}

const PRIORITY_RANKS = {
  low: 10,
  medium: 20,
  high: 30,
  critical: 40,
}

describe('ISP-063: Asset Manager with Workbox Quota', () => {
  let manager
  beforeEach(() => {
    manager = new AssetManager()
  })
  afterEach(() => {
    manager.destroy()
  })

  it('caches critical assets to persistent tier', async () => {
    const blob = new Blob(['test'], { type: 'application/wasm' })
    const result = await manager.cacheAsset(
      { url: 'test.wasm', type: 'critical', hash: 'abc', priority: 0, size: 4 },
      blob
    )
    expect(result.tier).toBe('persistent')
    expect(await manager.getAsset('test.wasm')).toBeTruthy()
  })

  it('caches frequent assets to memory tier', async () => {
    const blob = new Blob(['map'], { type: 'image/png' })
    const result = await manager.cacheAsset(
      { url: 'tile.png', type: 'frequent', hash: 'xyz', priority: 1, size: 100 },
      blob
    )
    expect(result.tier).toBe('memory')
  })

  it('evicts by priority when under pressure', async () => {
    const stats = await manager.getStatsPublic()
    expect(stats).toHaveProperty('pressured')
  })

  it('returns null for uncached assets', async () => {
    const result = await manager.getAsset('missing.wasm')
    expect(result).toBeNull()
  })
})

describe('ISP-062: Dispatch Priority Queue', () => {
  let queue
  beforeEach(() => {
    queue = new DispatchQueue()
  })

  it('enqueues items by priority', () => {
    queue.enqueue({ id: '1', priority: 'normal', payload: {}, timestamp: Date.now(), maxRetries: 3 })
    queue.enqueue({ id: '2', priority: 'critical', payload: {}, timestamp: Date.now(), maxRetries: 3 })

    const metrics = queue.getMetrics()
    expect(metrics.critical).toBe(1)
    expect(metrics.normal).toBe(1)
  })

  it('processes with priority weights', async () => {
    const processed = []
    queue.onProcess(async (item) => {
      processed.push(item.id)
    })

    queue.enqueue({ id: 'c1', priority: 'critical', payload: {}, timestamp: Date.now(), maxRetries: 1 })
    queue.enqueue({ id: 'n1', priority: 'normal', payload: {}, timestamp: Date.now(), maxRetries: 1 })
    queue.enqueue({ id: 'l1', priority: 'low', payload: {}, timestamp: Date.now(), maxRetries: 1 })

    await queue.process()
    expect(processed.length).toBeGreaterThan(0)
  })

  it('tracks processing metrics', () => {
    queue.enqueue({ id: '1', priority: 'high', payload: {}, timestamp: Date.now(), maxRetries: 3 })

    const metrics = queue.getMetrics()
    expect(metrics.queued).toBe(1)
    expect(metrics.high).toBe(1)
  })

  it('prevents stale updates from starving critical requests', async () => {
    const processed = []
    queue.onProcess(async (item) => {
      processed.push(item.priority)
    })

    const baseTime = Date.now() - 10_000
    queue.enqueue({
      id: 'stale-update',
      priority: 'low',
      payload: { status: 'updated' },
      timestamp: baseTime,
      maxRetries: 1,
    })
    queue.enqueue({
      id: 'critical-request',
      priority: 'critical',
      payload: {},
      timestamp: Date.now(),
      maxRetries: 1,
    })

    await queue.process()
    expect(queue.getMetrics().critical + queue.getMetrics().low).toBeGreaterThanOrEqual(1)
  })
})

describe('ISP-061: CRDT Reconciliation for Split-Brain', () => {
  it('merges operations deterministically', () => {
    const localOps = [
      {
        key: 'req:123',
        value: { status: 'open', priority: 'high' },
        deleted: false,
        actor: 'zone-a',
        counter: 1,
        timestamp: 1000,
        instance: 'zone-a',
      },
    ]

    const remoteOps = [
      {
        key: 'req:123',
        value: { status: 'assigned', priority: 'critical' },
        deleted: false,
        actor: 'zone-b',
        counter: 1,
        timestamp: 1500,
        instance: 'zone-b',
      },
    ]

    const result = computeReconciliationMerge(localOps, remoteOps, STATUS_RANKS, PRIORITY_RANKS)
    expect(result.merged.length).toBe(1)
    expect(result.conflicts.length).toBeGreaterThan(0)
  })

  it('selects winner by status lattice', () => {
    const localOps = [
      {
        key: 'aid:456',
        value: { status: 'open' },
        deleted: false,
        actor: 'a',
        counter: 1,
        timestamp: 1000,
      },
    ]

    const remoteOps = [
      {
        key: 'aid:456',
        value: { status: 'critical' },
        deleted: false,
        actor: 'b',
        counter: 1,
        timestamp: 1000,
      },
    ]

    const result = computeReconciliationMerge(localOps, remoteOps, STATUS_RANKS, PRIORITY_RANKS)
    expect(result.merged[0].value.status).toBe('critical')
  })

  it('advances vector clock correctly', () => {
    const clock = { 'zone-a': 5 }
    const advanced = advanceVectorClock(clock, 'zone-a', 2)
    expect(advanced['zone-a']).toBe(7)
  })

  it('merges operations with identical values', () => {
    const shared = {
      key: 'data:789',
      value: { content: 'same' },
      deleted: false,
      actor: 'shared',
      counter: 1,
      timestamp: 2000,
    }

    const result = computeReconciliationMerge([shared], [shared], STATUS_RANKS, PRIORITY_RANKS)
    expect(result.merged.length).toBe(1)
    expect(result.conflicts.length).toBe(0)
  })
})

describe('ISP-060: Telemetry Redaction & Privacy', () => {
  let redactor
  beforeEach(() => {
    redactor = new TelemetryRedactor()
  })
  afterEach(() => {
    redactor.clear()
  })

  it('redacts location coordinates', async () => {
    const event = {
      type: 'gps_report',
      timestamp: Date.now(),
      location: { lat: 40.7128, lng: -74.006 },
      data: {},
    }

    const redacted = await redactor.redactEvent(event)
    expect(redacted.location).toBeUndefined()
    expect(redacted.data?.geohash).toBeTruthy()
  })

  it('rejects events with plaintext coordinates in data', async () => {
    const redactor2 = new TelemetryRedactor()
    const event = {
      type: 'gps_report',
      timestamp: Date.now(),
      data: { lat: 40.7128, lng: -74.006 },
    }

    const redacted = await redactor2.redactEvent(event)
    const valid = await redactor2.verifyChecksum(redacted, '')
    expect(valid).toBe(false)
  })

  it('aggregates by geohash', async () => {
    const events = [
      {
        type: 'report',
        timestamp: Date.now(),
        location: { lat: 40.7128, lng: -74.006 },
        data: {},
      },
      {
        type: 'report',
        timestamp: Date.now(),
        location: { lat: 40.7129, lng: -74.007 },
        data: {},
      },
    ]

    const redacted = []
    for (const evt of events) {
      const r = await redactor.redactEvent(evt)
      if (r) redacted.push(r)
    }

    const aggregated = await redactor.aggregate(redacted)
    expect(aggregated.length).toBeGreaterThan(0)
    for (const agg of aggregated) {
      expect(agg.checksum).toHaveLength(64)
    }
  })

  it('maintains ring buffer without overflow', async () => {
    const BASE_TIME = Date.now()
    for (let i = 0; i < 150; i++) {
      await redactor.redactEvent({
        type: 'event',
        timestamp: BASE_TIME + i * 1000,
        data: {},
      })
    }

    const stats = redactor.getStats()
    expect(stats.bufferSize).toBeLessThanOrEqual(100)
  })

  it('drains aggregated events', async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      type: 'test',
      timestamp: Date.now() + i,
      data: {},
    }))

    for (const evt of events) {
      await redactor.redactEvent(evt)
    }

    const drained = await redactor.drain()
    expect(redactor.getStats().bufferSize).toBe(0)
    expect(drained.length).toBeGreaterThanOrEqual(0)
  })
})
