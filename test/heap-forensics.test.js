import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  CENSUS_SIZE,
  SIGNALS,
  SIGNAL_KIND,
  SELF_BYTES,
  DEFAULT_UA_MEMORY_PRESSURE_BYTES,
  sample,
  readCensus,
  readCensusMatrix,
  detectPressure,
  buildEnvelope,
  emitEnvelope,
  emergencyEmit,
  emitMemoryPressureEnvelope,
  probeUaSpecificMemory,
  isUaSpecificMemorySupported,
  attachForensicsToIncidentBundle,
  setForensicSubsystems,
  setPriorityLane,
  recordWorkerQueue,
  recordWorkerHeartbeat,
  recordWasmGrow,
  recordParserAlloc,
  recordRingBytes,
  resetHeapForensics,
} from '../src/lib/heapForensics'
import { RingBuffer } from '../src/lib/ringBuffer'

describe('heapForensics (#960 / #793)', () => {
  beforeEach(() => {
    resetHeapForensics()
  })

  afterEach(() => {
    resetHeapForensics()
  })

  it('caps the census at 50 entries and wraps oldest to newest', () => {
    expect(CENSUS_SIZE).toBe(50)
    for (let i = 0; i < 65; i++) {
      sample(1_000 + i)
    }
    const matrix = readCensusMatrix()
    expect(matrix).toHaveLength(50)
    expect(matrix[0][0]).toBe(1_015)
    expect(matrix[49][0]).toBe(1_064)
  })

  it('records NaN for missing or throwing probes without throwing', async () => {
    setForensicSubsystems({
      yjsDoc: {
        encodeState: () => {
          throw new Error('yjs unavailable')
        },
      },
      map: {
        getStyle: () => {
          throw new Error('map style detached')
        },
      },
      wasmMemory: () => {
        throw new Error('wasm uninitialized')
      },
    })

    expect(() => sample(2_000)).not.toThrow()
    const rows = readCensus()
    expect(rows).toHaveLength(1)
    expect(rows[0].yjsBytes).toBeNull()
    expect(rows[0].mapboxTiles).toBeNull()
    expect(rows[0].mapboxStyleBytes).toBeNull()
    expect(rows[0].wasmBytes).toBeNull()
    expect(rows[0].workerHeartbeatAgeMs).toBeNull()
    expect(rows[0].ringBytes).toBe(SELF_BYTES)

    // Missing measureUserAgentSpecificMemory yields NaN without throwing
    expect(isUaSpecificMemorySupported({})).toBe(false)
    await expect(probeUaSpecificMemory({})).resolves.toBeNaN()
    // Throwing measureUserAgentSpecificMemory yields NaN without throwing
    await expect(
      probeUaSpecificMemory({
        measureUserAgentSpecificMemory: async () => {
          throw new SecurityError('not crossOriginIsolated')
        },
      }),
    ).resolves.toBeNaN()
  })

  it('reuses preallocated row buffers so envelope emission allocates no per-sample objects', () => {
    sample(10_000)
    sample(10_001)
    const first = buildEnvelope('manual', { withHints: false })
    const rowRef0 = first.census[0]
    const rowRef1 = first.census[1]

    sample(10_002)
    const second = buildEnvelope('manual', { withHints: false })
    expect(second.census[0]).toBe(rowRef0)
    expect(second.census[1]).toBe(rowRef1)
    expect(second.census).toHaveLength(3)
  })

  it('samples and emits under performance.measureUserAgentSpecificMemory support and memory pressure', async () => {
    const emitted = []
    setPriorityLane((env) => emitted.push(env))

    sample(20_000)
    const fakePerf = {
      measureUserAgentSpecificMemory: async () => ({
        bytes: DEFAULT_UA_MEMORY_PRESSURE_BYTES + 1024,
        breakdown: [{ bytes: DEFAULT_UA_MEMORY_PRESSURE_BYTES + 1024, types: ['Window'] }],
      }),
    }

    expect(isUaSpecificMemorySupported(fakePerf)).toBe(true)
    const bytes = await probeUaSpecificMemory(fakePerf)
    expect(bytes).toBe(DEFAULT_UA_MEMORY_PRESSURE_BYTES + 1024)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].schema).toBe('helphone.forensics/1')
    expect(emitted[0].reason).toBe('heap_near_limit')
    expect(emitted[0].breakdown.jsHeapUsed).toBe(DEFAULT_UA_MEMORY_PRESSURE_BYTES + 1024)
  })

  it('attaches the fixed 50-entry census envelope to incident bundle extras', () => {
    recordWorkerQueue(4, 2048)
    recordWorkerHeartbeat(4_000)
    recordWasmGrow()
    recordParserAlloc(512)
    recordRingBytes(1024)
    sample(5_000)

    const files = attachForensicsToIncidentBundle({ 'server-logs/slice.txt': 'ok' }, 'manual')
    expect(files['client/heap-forensics.json']).toBeTruthy()
    const parsed = JSON.parse(files['client/heap-forensics.json'])
    expect(parsed.schema).toBe('helphone.forensics/1')
    expect(parsed.signals).toEqual([...SIGNALS])
    expect(parsed.census).toHaveLength(1)
    expect(Object.keys(SIGNAL_KIND)).toHaveLength(SIGNALS.length - 1)
  })

  it('emits a forensic envelope when RingBuffer enters critical pressure', () => {
    const emitted = []
    setPriorityLane((env) => emitted.push(env))

    const ring = new RingBuffer({ capacity: 4, shedWatermark: 0.75 })
    ring.push({ seq: 1, priority: 'normal', kind: 'a', ts: 1, payload: {} })
    ring.push({ seq: 2, priority: 'normal', kind: 'b', ts: 2, payload: {} })
    ring.push({ seq: 3, priority: 'normal', kind: 'c', ts: 3, payload: {} })

    expect(ring.currentPressure).toBe('critical')
    expect(emitted.length).toBeGreaterThanOrEqual(1)
    expect(emitted[0].schema).toBe('helphone.forensics/1')

    expect(emergencyEmit()).toBe(true)
    expect(emitted.at(-1).reason).toBe('crash')
  })
})

class SecurityError extends Error {}
