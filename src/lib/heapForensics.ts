/**
 * Production heap forensics without DevTools or --expose-gc (#793).
 *
 * Samples cheap per-subsystem proxies every `intervalMs` into a fixed
 * 50-entry census held in one preallocated Float64Array, so recording a
 * sample — and emitting the envelope under memory pressure — allocates no
 * per-sample objects. Every probe is optional and wrapped: a missing API
 * yields NaN ("not measurable here"), never a throw. See the measurability
 * matrix in docs/telemetry-architecture.md.
 *
 * The census carries sizes and counts only — no coordinates, ids, contact
 * strings or URLs — so it stays clear of the env_firewall PII patterns.
 */

export const CENSUS_SIZE = 50

/** Column order of a census row. Kept stable: the server validates by name. */
export const SIGNALS = [
  'ts',
  'jsHeapUsed',
  'jsHeapLimit',
  'workerQueueDepth',
  'workerPendingBytes',
  'workerHeartbeatAgeMs',
  'yjsBytes',
  'mapboxTiles',
  'mapboxStyleBytes',
  'ringBytes',
  'wasmBytes',
  'wasmGrowEvents',
  'parserAllocBytes',
  'storageUsage',
  'storageQuota',
] as const

export type Signal = (typeof SIGNALS)[number]
const WIDTH = SIGNALS.length
const COL = Object.fromEntries(SIGNALS.map((s, i) => [s, i])) as Record<Signal, number>

/** Which signals are direct measurements vs estimates (decision log, #793). */
export const SIGNAL_KIND: Record<Exclude<Signal, 'ts'>, 'measured' | 'estimate' | 'proxy'> = {
  jsHeapUsed: 'measured', // Chromium-only, main thread only, bucketed by the engine
  jsHeapLimit: 'measured',
  workerQueueDepth: 'measured',
  workerPendingBytes: 'estimate', // sum of structured-clone payload estimates
  workerHeartbeatAgeMs: 'proxy', // liveness, not memory
  yjsBytes: 'estimate', // encodeStateAsUpdate length ≈ doc store, excludes undo stack
  mapboxTiles: 'measured',
  mapboxStyleBytes: 'estimate', // JSON length of getStyle(); GPU memory invisible
  ringBytes: 'measured',
  wasmBytes: 'measured', // memory.buffer.byteLength, outside the JS heap
  wasmGrowEvents: 'measured',
  parserAllocBytes: 'measured',
  storageUsage: 'estimate', // storage.estimate() is padded by the UA
  storageQuota: 'estimate',
}

export type Probe = () => number | undefined | Promise<number | undefined>

export interface ForensicSubsystems {
  yjsDoc?: { encodeState: () => Uint8Array; topMaps?: () => Array<[string, number]> }
  map?: {
    getStyle?: () => unknown
    style?: { sourceCaches?: Record<string, { _tiles?: Record<string, unknown> }> }
  }
  wasmMemory?: () => WebAssembly.Memory | undefined
}

// ── Counters fed by instrumented subsystems (no allocation on hot paths) ────

const counters = {
  workerQueueDepth: 0,
  workerPendingBytes: 0,
  lastHeartbeat: 0,
  wasmGrowEvents: 0,
  parserAllocBytes: 0,
  ringBytes: 0,
}

export function recordWorkerQueue(depth: number, pendingBytes: number): void {
  counters.workerQueueDepth = depth
  counters.workerPendingBytes = pendingBytes
}
export function recordWorkerHeartbeat(at = Date.now()): void {
  counters.lastHeartbeat = at
}
export function recordWasmGrow(): void {
  counters.wasmGrowEvents += 1
}
export function recordParserAlloc(bytes: number): void {
  counters.parserAllocBytes += bytes
}
export function recordRingBytes(bytes: number): void {
  counters.ringBytes = bytes
}

/**
 * Wraps `memory.grow` so linear-memory growth is counted. WASM memory lives
 * outside the JS GC and is invisible to heap snapshots; this is the only
 * signal we get when it grows.
 */
export function instrumentWasmMemory(memory: WebAssembly.Memory): WebAssembly.Memory {
  const grow = memory.grow.bind(memory)
  try {
    Object.defineProperty(memory, 'grow', {
      configurable: true,
      value: (delta: number) => {
        recordWasmGrow()
        return grow(delta)
      },
    })
  } catch {}
  return memory
}

// ── Census store ─────────────────────────────────────────────────────────────

const census = new Float64Array(CENSUS_SIZE * WIDTH).fill(NaN)
const preallocatedRowPool: Array<Array<number | null>> = Array.from(
  { length: CENSUS_SIZE },
  () => new Array<number | null>(WIDTH).fill(null),
)
let head = 0
let filled = 0
let storageCache = { usage: NaN, quota: NaN }
let uaSpecificBytes = NaN
let subsystems: ForensicSubsystems = {}
let lastEnvelope: ForensicEnvelope | null = null

/** Default memory-pressure threshold (512 MB) when jsHeapSizeLimit is unavailable. */
export const DEFAULT_UA_MEMORY_PRESSURE_BYTES = 512 * 1024 * 1024

/** Bytes this module itself retains (reported so the census counts its own cost). */
export const SELF_BYTES = census.byteLength

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : NaN
}

function safe(fn: () => number | undefined): number {
  try {
    return num(fn())
  } catch {
    return NaN
  }
}

function mapboxTileCount(): number {
  return safe(() => {
    const caches = subsystems.map?.style?.sourceCaches
    if (!caches) return NaN
    let n = 0
    for (const id in caches) n += Object.keys(caches[id]?._tiles ?? {}).length
    return n
  })
}

export function isUaSpecificMemorySupported(
  perf: unknown = typeof performance !== 'undefined' ? performance : undefined,
): boolean {
  try {
    return typeof (perf as { measureUserAgentSpecificMemory?: unknown } | undefined)?.measureUserAgentSpecificMemory === 'function'
  } catch {
    return false
  }
}

/**
 * Probes `performance.measureUserAgentSpecificMemory()` when supported (COOP/COEP
 * cross-origin isolated contexts). Missing or throwing APIs yield NaN and never throw.
 */
export async function probeUaSpecificMemory(
  perf: unknown = typeof performance !== 'undefined' ? performance : undefined,
): Promise<number> {
  if (!isUaSpecificMemorySupported(perf)) {
    uaSpecificBytes = NaN
    return NaN
  }
  try {
    const fn = (
      perf as {
        measureUserAgentSpecificMemory: () => Promise<{ bytes?: number }>
      }
    ).measureUserAgentSpecificMemory
    const result = await fn.call(perf)
    uaSpecificBytes = num(result?.bytes)
    if (!Number.isNaN(uaSpecificBytes) && filled > 0) {
      const latestRow = ((head - 1 + CENSUS_SIZE) % CENSUS_SIZE) * WIDTH
      if (Number.isNaN(census[latestRow + COL.jsHeapUsed])) {
        census[latestRow + COL.jsHeapUsed] = uaSpecificBytes
      }
      const latestIdx = (head - 1 + CENSUS_SIZE) % CENSUS_SIZE
      const reason = detectPressure(latestIdx)
      if (reason) emitEnvelope(buildEnvelope(reason))
    }
    return uaSpecificBytes
  } catch {
    uaSpecificBytes = NaN
    return NaN
  }
}

/** Synchronous sample written straight into the preallocated census row. */
export function sample(now = Date.now()): number {
  const row = head * WIDTH
  const heapUsed = safe(() => {
    const mem = (typeof performance !== 'undefined'
      ? (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory
      : undefined)
    return mem?.usedJSHeapSize
  })
  const heapLimit = safe(() => {
    const mem = (typeof performance !== 'undefined'
      ? (performance as unknown as { memory?: { jsHeapSizeLimit?: number } }).memory
      : undefined)
    return mem?.jsHeapSizeLimit
  })
  census[row + COL.ts] = num(now)
  census[row + COL.jsHeapUsed] = Number.isNaN(heapUsed) ? uaSpecificBytes : heapUsed
  census[row + COL.jsHeapLimit] = heapLimit
  census[row + COL.workerQueueDepth] = num(counters.workerQueueDepth)
  census[row + COL.workerPendingBytes] = num(counters.workerPendingBytes)
  census[row + COL.workerHeartbeatAgeMs] = counters.lastHeartbeat ? num(now - counters.lastHeartbeat) : NaN
  census[row + COL.yjsBytes] = safe(() => subsystems.yjsDoc?.encodeState().byteLength)
  census[row + COL.mapboxTiles] = mapboxTileCount()
  census[row + COL.mapboxStyleBytes] = safe(() => {
    const style = subsystems.map?.getStyle?.()
    return style ? JSON.stringify(style).length : undefined
  })
  census[row + COL.ringBytes] = num(counters.ringBytes + SELF_BYTES)
  census[row + COL.wasmBytes] = safe(() => subsystems.wasmMemory?.()?.buffer.byteLength)
  census[row + COL.wasmGrowEvents] = num(counters.wasmGrowEvents)
  census[row + COL.parserAllocBytes] = num(counters.parserAllocBytes)
  census[row + COL.storageUsage] = num(storageCache.usage)
  census[row + COL.storageQuota] = num(storageCache.quota)
  const written = head
  head = (head + 1) % CENSUS_SIZE
  filled = Math.min(filled + 1, CENSUS_SIZE)
  return written
}

async function refreshStorage(): Promise<void> {
  try {
    const est = await (typeof navigator !== 'undefined' ? navigator.storage?.estimate?.() : undefined)
    storageCache = { usage: num(est?.usage), quota: num(est?.quota) }
  } catch {
    storageCache = { usage: NaN, quota: NaN }
  }
}

/**
 * Reads census rows oldest → newest into the preallocated row pool (NaN → null)
 * without allocating per-sample objects.
 */
export function readCensusMatrix(): Array<Array<number | null>> {
  const rows: Array<Array<number | null>> = new Array(filled)
  for (let i = 0; i < filled; i++) {
    const r = ((head - filled + i + CENSUS_SIZE) % CENSUS_SIZE) * WIDTH
    const row = preallocatedRowPool[i]
    for (let c = 0; c < WIDTH; c++) {
      const v = census[r + c]
      row[c] = Number.isNaN(v) ? null : v
    }
    rows[i] = row
  }
  return rows
}

/** Reads census rows oldest → newest as plain objects (allocates; not for OOM path). */
export function readCensus(): Array<Record<Signal, number | null>> {
  const rows: Array<Record<Signal, number | null>> = []
  for (let i = 0; i < filled; i++) {
    const r = ((head - filled + i + CENSUS_SIZE) % CENSUS_SIZE) * WIDTH
    const out = {} as Record<Signal, number | null>
    SIGNALS.forEach((s, c) => (out[s] = Number.isNaN(census[r + c]) ? null : census[r + c]))
    rows.push(out)
  }
  return rows
}

// ── Pressure detection + envelope ────────────────────────────────────────────

export type PressureReason = 'manual' | 'heartbeat_stall' | 'heap_near_limit' | 'storage_near_quota' | 'crash'

const HEARTBEAT_STALL_MS = 30_000
const HEAP_PRESSURE = 0.85
const STORAGE_PRESSURE = 0.9

export function detectPressure(rowIndex: number): PressureReason | null {
  const r = rowIndex * WIDTH
  if (census[r + COL.workerHeartbeatAgeMs] > HEARTBEAT_STALL_MS) return 'heartbeat_stall'
  const heapUsed = census[r + COL.jsHeapUsed]
  const heapLimit = census[r + COL.jsHeapLimit]
  if (heapUsed / heapLimit > HEAP_PRESSURE) return 'heap_near_limit'
  if (Number.isNaN(heapLimit) && heapUsed > DEFAULT_UA_MEMORY_PRESSURE_BYTES) return 'heap_near_limit'
  if (census[r + COL.storageUsage] / census[r + COL.storageQuota] > STORAGE_PRESSURE) return 'storage_near_quota'
  return null
}

export interface ForensicEnvelope {
  schema: 'helphone.forensics/1'
  reason: PressureReason
  ts: number
  ua: 'chromium' | 'firefox' | 'webkit' | 'other'
  signals: readonly string[]
  /** Census rows, oldest first, NaN encoded as null; one array per row. */
  census: Array<Array<number | null>>
  breakdown: Record<string, number>
  hints: { yjsTopMaps?: Array<[string, number]>; mapboxTopSources?: Array<[string, number]> }
}

function uaFamily(): ForensicEnvelope['ua'] {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Chrom(e|ium)\//.test(ua)) return 'chromium'
  if (/AppleWebKit\//.test(ua)) return 'webkit'
  return 'other'
}

/** Latest-row subsystem breakdown in bytes (only byte-valued signals). */
export function breakdown(): Record<string, number> {
  if (filled === 0) return {}
  const r = ((head - 1 + CENSUS_SIZE) % CENSUS_SIZE) * WIDTH
  const out: Record<string, number> = {}
  for (const s of ['jsHeapUsed', 'workerPendingBytes', 'yjsBytes', 'mapboxStyleBytes', 'ringBytes', 'wasmBytes'] as const) {
    const v = census[r + COL[s]]
    if (!Number.isNaN(v)) out[s] = v
  }
  return out
}

export function buildEnvelope(reason: PressureReason, { withHints = true } = {}): ForensicEnvelope {
  const hints: ForensicEnvelope['hints'] = {}
  if (withHints) {
    try {
      hints.yjsTopMaps = subsystems.yjsDoc?.topMaps?.().slice(0, 5)
    } catch {}
    try {
      const caches = subsystems.map?.style?.sourceCaches ?? {}
      hints.mapboxTopSources = Object.entries(caches)
        .map(([id, c]) => [id.slice(0, 40), Object.keys(c?._tiles ?? {}).length] as [string, number])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
    } catch {}
  }
  const envelope: ForensicEnvelope = {
    schema: 'helphone.forensics/1',
    reason,
    ts: Date.now(),
    ua: uaFamily(),
    signals: SIGNALS,
    census: readCensusMatrix(),
    breakdown: breakdown(),
    hints,
  }
  lastEnvelope = envelope
  return envelope
}

export function getLatestForensicEnvelope(): ForensicEnvelope | null {
  return lastEnvelope
}

/**
 * Attaches the fixed 50-entry forensic census envelope to an incident bundle's
 * `extraFiles` map under `client/heap-forensics.json`.
 */
export function attachForensicsToIncidentBundle(
  extraFiles: Record<string, string> = {},
  reason: PressureReason = 'manual',
): Record<string, string> {
  if (filled === 0) sample()
  const env = lastEnvelope && lastEnvelope.reason === reason ? lastEnvelope : buildEnvelope(reason)
  return {
    ...extraFiles,
    'client/heap-forensics.json': JSON.stringify(env, null, 2),
  }
}

const ENDPOINT = '/api/telemetry/forensics'
let lastEmit = 0
const MIN_EMIT_GAP_MS = 5 * 60_000

/**
 * Emits through the telemetry worker's priority lane when available, else
 * sendBeacon (survives pagehide and does not wait on the event loop), else
 * keepalive fetch. Rate-limited so a stuck pressure signal cannot flood.
 */
export function emitEnvelope(envelope: ForensicEnvelope, { force = false } = {}): boolean {
  const now = Date.now()
  if (!force && now - lastEmit < MIN_EMIT_GAP_MS) return false
  lastEmit = now
  lastEnvelope = envelope
  try {
    if (priorityLane) {
      priorityLane(envelope)
      return true
    }
    const body = JSON.stringify(envelope)
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: 'application/json' }))) {
      return true
    }
    if (typeof fetch === 'function') {
      void fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {})
      return true
    }
    return false
  } catch {
    return false
  }
}

let priorityLane: ((e: ForensicEnvelope) => void) | null = null
/** Telemetry worker registers its jump-the-queue flush here. */
export function setPriorityLane(fn: ((e: ForensicEnvelope) => void) | null): void {
  priorityLane = fn
}

/**
 * OOM-safe emit for crash paths (ErrorBoundary / crashRecovery). Skips the
 * retainer hints (those walk Yjs/Mapbox structures) and sends only the
 * preallocated census — the smallest payload that still attributes memory.
 */
export function emergencyEmit(): boolean {
  try {
    if (filled === 0) sample()
    return emitEnvelope(buildEnvelope('crash', { withHints: false }), { force: true })
  } catch {
    return false
  }
}

/**
 * Samples the fixed 50-entry census and emits a memory-pressure forensic
 * envelope without allocating per-sample objects.
 */
export function emitMemoryPressureEnvelope(
  reason: PressureReason = 'heap_near_limit',
  opts: { force?: boolean; withHints?: boolean } = {},
): ForensicEnvelope {
  const row = sample()
  const detected = detectPressure(row) ?? reason
  const env = buildEnvelope(detected, { withHints: opts.withHints ?? true })
  emitEnvelope(env, { force: opts.force ?? false })
  return env
}

let timer: ReturnType<typeof setInterval> | undefined

export function startHeapForensics(
  opts: { intervalMs?: number; subsystems?: ForensicSubsystems } = {},
): () => void {
  const intervalMs = Math.min(Math.max(opts.intervalMs ?? 30_000, 15_000), 60_000)
  subsystems = opts.subsystems ?? subsystems
  stopHeapForensics()
  const tick = () => {
    // Off the critical path: idle callback where supported, else a timeout.
    const run = () => {
      void refreshStorage()
      void probeUaSpecificMemory()
      const row = sample()
      const reason = detectPressure(row)
      if (reason) emitEnvelope(buildEnvelope(reason))
    }
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => void }).requestIdleCallback
    if (ric) ric(run, { timeout: 2_000 })
    else setTimeout(run, 0)
  }
  timer = setInterval(tick, intervalMs)
  tick()
  if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>).__helphone_forceHeapSnapshot = () => {
      sample()
      const env = buildEnvelope('manual')
      emitEnvelope(env, { force: true })
      return env
    }
  }
  return stopHeapForensics
}

export function setForensicSubsystems(next: ForensicSubsystems): void {
  subsystems = { ...subsystems, ...next }
}

export function stopHeapForensics(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

export function resetHeapForensics(): void {
  stopHeapForensics()
  census.fill(NaN)
  for (let i = 0; i < CENSUS_SIZE; i++) {
    preallocatedRowPool[i].fill(null)
  }
  head = 0
  filled = 0
  storageCache = { usage: NaN, quota: NaN }
  uaSpecificBytes = NaN
  subsystems = {}
  lastEnvelope = null
  lastEmit = 0
  priorityLane = null
  counters.workerQueueDepth = 0
  counters.workerPendingBytes = 0
  counters.lastHeartbeat = 0
  counters.wasmGrowEvents = 0
  counters.parserAllocBytes = 0
  counters.ringBytes = 0
}
