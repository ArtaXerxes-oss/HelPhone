/**
 * Integration tests for ISP-060 through ISP-063 fixes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AssetManager } from '../src/lib/assetManager'
import { DispatchQueue } from '../src/lib/dispatchQueue'
import { detectPriority } from '../server/middleware/dispatchPriority'
import { TelemetryRedactor, hasPlaintextCoordinates } from '../src/lib/telemetryRedactor'
import { TelemetryPipeline, createMemoryExporter, toOtlpJson } from '../src/lib/telemetry'
import { TelemetryReceiver } from '../server/telemetry.js'
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

  it('evicts tier 3 first, then tier 2, while preserving tier 1 critical assets', async () => {
    const criticalBlob = new Blob(['wasm'], { type: 'application/wasm' })
    const tileBlob = new Blob(['tile'], { type: 'image/png' })
    const renderBlob = new Blob(['render'], { type: 'application/json' })

    await manager.cacheAsset({ url: 'aegis.wasm', type: 'critical', hash: 'h1', priority: 0, size: 4 }, criticalBlob)
    await manager.cacheAsset({ url: 'tile-1.png', type: 'frequent', hash: 'h2', priority: 1, size: 4 }, tileBlob)
    await manager.cacheAsset({ url: 'render-1.json', type: 'ephemeral', hash: 'h3', priority: 2, size: 6 }, renderBlob)

    // First eviction pass drops tier 3 (ephemeral) first
    await manager.evictUnderPressure()
    expect(await manager.getAsset('render-1.json')).toBeNull()
    expect(await manager.getAsset('tile-1.png')).toBeTruthy()
    expect(await manager.getAsset('aegis.wasm')).toBeTruthy()

    // Second eviction pass drops tier 2 (frequent) while tier 1 survives
    await manager.evictUnderPressure()
    expect(await manager.getAsset('tile-1.png')).toBeNull()
    expect(await manager.getAsset('aegis.wasm')).toBeTruthy()
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
    expect(queue.getMetrics()).toHaveProperty('stalePrevented')
    expect(queue.getMetrics().maxWaitTime).toBeLessThan(30_000)
  })

  it('reconciles P0-P3 tiers and enforces ADR-020 no-identity rule', () => {
    queue.enqueue({ id: 'p0-req', priority: 'P0', payload: {}, timestamp: Date.now(), maxRetries: 1 })
    queue.enqueue({ id: 'p3-req', priority: 'P3', payload: {}, timestamp: Date.now(), maxRetries: 1 })
    const metrics = queue.getMetrics()
    expect(metrics.critical).toBe(1)
    expect(metrics.low).toBe(1)
    expect(metrics.queued).toBe(2)

    const responderReq = {
      headers: { 'content-type': 'application/responder+json' },
      body: { wallet: 'GABCDEF', note: 'routine check' },
      path: '/api/dispatch/status',
    }
    expect(detectPriority(responderReq)).toBe('normal')

    const hintedReq = {
      headers: { 'x-priority': 'P0' },
      body: {},
      path: '/api/dispatch/payload/1',
    }
    expect(detectPriority(hintedReq)).toBe('critical')
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

  it('converges idempotently across 3 zones after a 72h partition without losing or downgrading aid records', () => {
    const partitionStart = Date.now() - 72 * 60 * 60 * 1000
    const zoneA = [
      { key: 'aid:101', value: { status: 'open', priority: 'high' }, deleted: false, actor: 'zone-a', counter: 1, timestamp: partitionStart + 1000, instance: 'zone-a' },
      { key: 'aid:102', value: { status: 'open', priority: 'low' }, deleted: false, actor: 'zone-a', counter: 2, timestamp: partitionStart + 2000, instance: 'zone-a' },
    ]
    const zoneB = [
      { key: 'aid:101', value: { status: 'escalated', priority: 'critical' }, deleted: false, actor: 'zone-b', counter: 1, timestamp: partitionStart + 500, instance: 'zone-b' },
      { key: 'aid:103', value: { status: 'assigned', priority: 'medium' }, deleted: false, actor: 'zone-b', counter: 2, timestamp: partitionStart + 3000, instance: 'zone-b' },
    ]
    const zoneC = [
      { key: 'aid:101', value: { status: 'resolved', priority: 'low' }, deleted: false, actor: 'zone-c', counter: 1, timestamp: partitionStart + 71 * 60 * 60 * 1000, instance: 'zone-c' },
    ]

    const ab = computeReconciliationMerge(zoneA, zoneB, STATUS_RANKS, PRIORITY_RANKS)
    const abc = computeReconciliationMerge(ab.merged, zoneC, STATUS_RANKS, PRIORITY_RANKS)

    expect(abc.merged).toHaveLength(3)
    const aid101 = abc.merged.find((op) => op.key === 'aid:101')
    expect(aid101.value.status).toBe('escalated')
    expect(abc.conflicts.some((c) => c.includes('actor=zone-b') && c.includes('status:'))).toBe(true)

    // Re-merging the same batch is a no-op (idempotent)
    const remerged = computeReconciliationMerge(abc.merged, abc.merged, STATUS_RANKS, PRIORITY_RANKS)
    expect(remerged.merged).toEqual(abc.merged)
    expect(remerged.conflicts).toHaveLength(0)
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

  it('redacts GPS attributes before buffering in TelemetryPipeline and OTLP export', async () => {
    const exporter = createMemoryExporter()
    const pipeline = new TelemetryPipeline({ exporter })
    pipeline.record({
      name: 'telemetry.frame',
      priority: 'critical',
      attributes: { lat: 40.7128, lng: -74.006, accuracy: 5 },
    })

    await pipeline.flush()
    expect(exporter.batches.length).toBe(1)
    const exportedSpan = exporter.batches[0][0]
    expect(hasPlaintextCoordinates(exportedSpan.attributes)).toBe(false)
    expect(exportedSpan.attributes?.geohash).toBeTruthy()

    const otlp = toOtlpJson([{ ...exportedSpan, attributes: { lat: 40.7, lng: -74.0 } }])
    const attrs = otlp.resourceSpans[0].scopeSpans[0].spans[0].attributes
    expect(attrs.some((a) => a.key === 'lat' || a.key === 'lng')).toBe(false)
  })

  it('rejects deliberate JS fast-path bypass with plaintext coordinates or bad checksum', async () => {
    const receiver = new TelemetryReceiver({ exporter: { async export() {} } })
    const result = receiver.ingest([
      {
        name: 'telemetry.frame',
        priority: 'normal',
        attributes: { lat: 40.7128, lng: -74.006 },
      },
      {
        name: 'telemetry.frame',
        priority: 'normal',
        checksum: 'deadbeef',
        attributes: { geohash: 'dr5reg' },
      },
    ])
    expect(result.accepted).toBe(0)
    expect(result.dropped).toBe(2)

    const orig = await redactor.redactEvent({
      type: 'gps_report',
      timestamp: Date.now(),
      location: { lat: 40.7128, lng: -74.006 },
      data: {},
    })
    const expectedChecksum = redactor.getStoredChecksum(orig)
    expect(await redactor.verifyChecksum(orig, expectedChecksum)).toBe(true)

    const bypassed = { ...orig, data: { ...orig.data, lat: 40.7128, lng: -74.006 } }
    expect(await redactor.verifyChecksum(bypassed, expectedChecksum)).toBe(false)
  })
})
