import { describe, it, expect, vi } from 'vitest'
import {
  RACE_MAX_PER_HOUR,
  RACE_LOW_BATTERY_LEVEL,
  isRaceFlagOn,
  decideRace,
  readConnection,
  readMeteredSignal,
  readBatteryLevel,
  createRaceTracker,
} from '../src/lib/raceGate'
import { createNetworkTransport } from '../src/services/networkTransport.js'
import { WsClient } from '../src/lib/wsClient'

const baseCtx = () => ({
  payload: 'P0',
  path: { rttMs: 950, stalled: true, metered: false },
  batteryLevel: 0.75,
  racesLastHour: 0,
  operatorOverride: false,
})

describe('raceGate pure policy branches (ISP-120 / #959)', () => {
  it('parses the VITE_MULTIPATH_RACE flag strictly', () => {
    expect(isRaceFlagOn('true')).toBe(true)
    expect(isRaceFlagOn('false')).toBe(false)
    expect(isRaceFlagOn(undefined)).toBe(false)
    expect(isRaceFlagOn('1')).toBe(false)
  })

  it('vetoes when the feature flag is off', () => {
    expect(decideRace(false, baseCtx())).toEqual({ race: false, reason: 'flag-off' })
  })

  it('vetoes P1 and bulk payloads (never race)', () => {
    expect(decideRace(true, { ...baseCtx(), payload: 'P1' })).toEqual({
      race: false,
      reason: 'not-p0',
    })
    expect(decideRace(true, { ...baseCtx(), payload: 'bulk' })).toEqual({
      race: false,
      reason: 'not-p0',
    })
  })

  it('vetoes when the primary path is healthy (not stalled)', () => {
    expect(
      decideRace(true, {
        ...baseCtx(),
        path: { rttMs: 40, stalled: false, metered: false },
      }),
    ).toEqual({ race: false, reason: 'path-healthy' })
  })

  it('vetoes on a metered bearer unless operatorOverride is set for P0', () => {
    expect(
      decideRace(true, {
        ...baseCtx(),
        path: { rttMs: 950, stalled: true, metered: true },
        operatorOverride: false,
      }),
    ).toEqual({ race: false, reason: 'metered-bearer' })

    expect(
      decideRace(true, {
        ...baseCtx(),
        path: { rttMs: 950, stalled: true, metered: true },
        operatorOverride: true,
      }),
    ).toEqual({ race: true })
  })

  it('vetoes on low battery (< 0.2) and allows when battery is sufficient or API unavailable (null)', () => {
    expect(RACE_LOW_BATTERY_LEVEL).toBe(0.2)
    expect(decideRace(true, { ...baseCtx(), batteryLevel: 0.15 })).toEqual({
      race: false,
      reason: 'low-battery',
    })
    expect(decideRace(true, { ...baseCtx(), batteryLevel: 0.2 })).toEqual({ race: true })
    expect(decideRace(true, { ...baseCtx(), batteryLevel: null })).toEqual({ race: true })
  })

  it('vetoes once the rolling hourly cap is reached', () => {
    expect(RACE_MAX_PER_HOUR).toBe(20)
    expect(decideRace(true, { ...baseCtx(), racesLastHour: 20 })).toEqual({
      race: false,
      reason: 'hourly-cap',
    })
    expect(decideRace(true, { ...baseCtx(), racesLastHour: 19 })).toEqual({ race: true })
  })

  it('reads veto signals from navigator.getConnection() and navigator.getBattery()', async () => {
    const navWithGetConnection = {
      getConnection: () => ({ metered: true, effectiveType: '4g' }),
      getBattery: async () => ({ level: 0.12, charging: false }),
    }
    expect(readConnection(navWithGetConnection)).toEqual({ metered: true, effectiveType: '4g' })
    expect(readMeteredSignal(navWithGetConnection)).toBe(true)
    await expect(readBatteryLevel(navWithGetConnection)).resolves.toBe(0.12)

    const navWithSaveData = {
      connection: { saveData: true },
    }
    expect(readMeteredSignal(navWithSaveData)).toBe(true)
    await expect(readBatteryLevel(navWithSaveData)).resolves.toBeNull()
  })

  it('tracks rolling hour races and expires entries older than 1 hour', () => {
    let clock = 1_000_000
    const tracker = createRaceTracker(() => clock)
    tracker.record()
    clock += 1_000
    tracker.record()
    expect(tracker.count()).toBe(2)

    clock += 3_600_000
    expect(tracker.count()).toBe(0)
  })
})

describe('networkTransport P0 multipath race & responder deduplication (#959)', () => {
  it('fires one redundant copy on a stalled P0 send, never races P1/bulk, and dedupes on receive', async () => {
    const primarySent = []
    const secondarySent = []
    const received = []

    class FakeWS {
      constructor(url) {
        this.url = url
        queueMicrotask(() => this.onopen?.())
      }
      send(text) {
        primarySent.push(JSON.parse(text))
      }
      close() {}
    }

    const nav = {
      onLine: true,
      getConnection: () => ({ metered: false, type: 'wifi' }),
      getBattery: () => Promise.resolve({ level: 0.85, charging: true }),
    }

    const transport = createNetworkTransport({
      endpoints: { webSocket: 'wss://alerts.test/ws' },
      globals: { WebSocket: FakeWS, navigator: nav },
      raceFlagOn: true,
      secondarySend: (text) => secondarySent.push(JSON.parse(text)),
      onMessage: (msg) => received.push(msg),
    })

    transport.start()
    await new Promise((r) => setTimeout(r, 10))

    // P1 and bulk never race even when path is stalled
    const p1Res = transport.sendDispatch(
      { idempotencyKey: 'disp-p1', type: 'alert', payloadClass: 'P1' },
      { stalled: true },
    )
    expect(p1Res.raced).toBe(false)
    expect(p1Res.decision).toEqual({ race: false, reason: 'not-p0' })

    const bulkRes = transport.sendDispatch(
      { idempotencyKey: 'disp-bulk', type: 'sync', payloadClass: 'bulk' },
      { stalled: true },
    )
    expect(bulkRes.raced).toBe(false)
    expect(bulkRes.decision).toEqual({ race: false, reason: 'not-p0' })
    expect(secondarySent).toHaveLength(0)

    // P0 on a stalled path fires one redundant copy on the secondary path
    const p0Res = transport.sendDispatch(
      { idempotencyKey: 'disp-p0-1', type: 'sos', payloadClass: 'P0' },
      { stalled: true },
    )
    expect(p0Res.raced).toBe(true)
    expect(p0Res.decision).toEqual({ race: true })
    await new Promise((r) => setTimeout(r, 10))
    expect(secondarySent).toHaveLength(1)
    expect(secondarySent[0].idempotencyKey).toBe('disp-p0-1')

    // Vetoed when navigator.getConnection() reports metered bearer
    nav.getConnection = () => ({ metered: true })
    const meteredRes = transport.sendDispatch(
      { idempotencyKey: 'disp-p0-2', type: 'sos', payloadClass: 'P0' },
      { stalled: true },
    )
    expect(meteredRes.raced).toBe(false)
    expect(meteredRes.decision).toEqual({ race: false, reason: 'metered-bearer' })

    // Responder receives both primary and redundant copies with same idempotencyKey -> deduplicated!
    transport.receiveFrame({ idempotencyKey: 'disp-p0-1', type: 'sos', seq: 1 })
    transport.receiveFrame({ idempotencyKey: 'disp-p0-1', type: 'sos', seq: 1 })
    expect(received).toHaveLength(1)
    expect(transport.getMetrics().duplicatesDropped).toBe(1)
    expect(transport.getMetrics().racesFired).toBe(1)

    transport.stop()
  })
})

describe('WsClient P0 multipath race & responder deduplication (#959)', () => {
  it('gates redundant sends with decideRace and drops duplicate dispatches by idempotencyKey', () => {
    const secondaryPayloads = []
    const delivered = []
    const client = new WsClient({
      url: 'wss://dispatch.test/ws',
      raceFlagOn: true,
      secondarySend: (payload) => secondaryPayloads.push(JSON.parse(payload)),
      onMessage: (msg) => delivered.push(msg),
      navigator: {
        getConnection: () => ({ metered: false }),
        battery: { level: 0.9, charging: false },
      },
    })

    // Stalled P0 races via secondarySend
    const p0 = client.sendDispatch(
      { idempotencyKey: 'ws-p0-1', action: 'dispatch' },
      { payload: 'P0', stalled: true },
    )
    expect(p0.raced).toBe(true)
    expect(secondaryPayloads).toHaveLength(1)

    // Low battery vetoes P0 race
    const lowBat = client.sendDispatch(
      { idempotencyKey: 'ws-p0-2', action: 'dispatch' },
      { payload: 'P0', stalled: true, batteryLevel: 0.1 },
    )
    expect(lowBat.raced).toBe(false)
    expect(lowBat.decision).toEqual({ race: false, reason: 'low-battery' })

    // Inbound duplicate with same idempotencyKey is dropped
    expect(client.handleInboundMessage(JSON.stringify({ idempotencyKey: 'ws-p0-1', action: 'dispatch' }))).toBe(true)
    expect(client.handleInboundMessage(JSON.stringify({ idempotencyKey: 'ws-p0-1', action: 'dispatch' }))).toBe(false)
    expect(delivered).toHaveLength(1)
    expect(client.getDuplicatesDropped()).toBe(1)
  })
})
