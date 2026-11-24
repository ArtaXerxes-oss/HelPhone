/**
 * src/lib/bleRelay.ts — ISP-113 / #783 spike prototype: authenticated BLE
 * proximity beacon (wire format v0), fragmentation/reassembly and a
 * verify-before-forward relay gate.
 *
 * Transport-free by design: nothing here touches `navigator.bluetooth`. A
 * GATT transport hands raw fragments to `BeaconReassembler` and asks
 * `BleRelayGate` whether a reassembled beacon may be forwarded. The prototype
 * is flag-gated (`VITE_BLE_GOSSIP`) and is NOT wired into `syncManager.ts`.
 *
 * Wire format (all integers big-endian):
 *   fragment = 'H'(0x48) | version(1) | index(1) | total(1) | msgCrc32(4) | chunk
 *   message  = UTF-8 JSON array
 *              [v, incidentId, geohash, severity, seq, issuedAt, expiresAt, signer, note, sigHex]
 *   signature covers `canonicalBeaconString()` (Ed25519, signer = station-provisioned public key)
 * `msgCrc32` is the CRC-32 of the whole message and doubles as the reassembly id and checksum.
 */
import { signEd25519Message, verifyEd25519Signature } from './crypto'

export const BLE_BEACON_VERSION = 0
export const FRAGMENT_MAGIC = 0x48
export const FRAGMENT_HEADER_BYTES = 8
/** Conservative default ATT payload (23-byte default MTU minus 3 bytes of ATT overhead). */
export const DEFAULT_MTU = 20
export const MAX_FRAGMENTS = 32
export const MAX_MESSAGE_BYTES = 2048
export const MAX_NOTE_CHARS = 80
export const MAX_BEACON_TTL_S = 15 * 60
export const MAX_CLOCK_SKEW_S = 30

export type BeaconSeverity = 0 | 1 | 2 | 3

export interface Beacon {
  v: number
  incidentId: string
  geohash: string
  severity: BeaconSeverity
  /** Per (signer, incident) monotonic sequence number. */
  seq: number
  /** Unix seconds. */
  issuedAt: number
  /** Unix seconds; must be within MAX_BEACON_TTL_S of issuedAt. */
  expiresAt: number
  /** Station-provisioned Ed25519 public key (strkey). */
  signer: string
  note: string
  sig: string
}

export type DropReason =
  | 'malformed'
  | 'version'
  | 'expired'
  | 'future-dated'
  | 'ttl-too-long'
  | 'untrusted-signer'
  | 'bad-signature'
  | 'replay'
  | 'duplicate'
  | 'rate-limited'

export type GateDecision = { forward: true } | { forward: false; reason: DropReason }

/** Gate flag: the whole BLE path stays inert unless explicitly enabled. */
export function isBleGossipEnabled(env: Record<string, unknown> = {}): boolean {
  const v = env.VITE_BLE_GOSSIP
  return v === true || v === 'true' || v === '1'
}

/** Bearer policy: only life-safety beacons may use a BLE trickle bearer; telemetry is embargoed. */
export type PayloadKind = 'incident-beacon' | 'telemetry' | 'crdt-bulk'
export type Bearer = 'broadband' | 'ble-trickle'
export function isPayloadAllowedOnBearer(kind: PayloadKind, bearer: Bearer): boolean {
  return bearer === 'broadband' || kind === 'incident-beacon'
}

// --- CRC-32 -----------------------------------------------------------------

let crcTable: Uint32Array | null = null
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// --- Beacon encode / sign ---------------------------------------------------

export function canonicalBeaconString(b: Omit<Beacon, 'sig'>): string {
  return [b.v, b.incidentId, b.geohash, b.severity, b.seq, b.issuedAt, b.expiresAt, b.signer, b.note].join('|')
}

export function signBeacon(unsigned: Omit<Beacon, 'sig' | 'signer'>, publicKey: string, secretKey: string): Beacon {
  const withSigner = { ...unsigned, signer: publicKey }
  return { ...withSigner, sig: signEd25519Message(canonicalBeaconString(withSigner), secretKey) }
}

export function encodeBeacon(b: Beacon): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([b.v, b.incidentId, b.geohash, b.severity, b.seq, b.issuedAt, b.expiresAt, b.signer, b.note, b.sig])
  )
}

/** Returns null for anything that is not a well-typed v0-shaped beacon. Never throws. */
export function decodeBeacon(bytes: Uint8Array): Beacon | null {
  if (bytes.length === 0 || bytes.length > MAX_MESSAGE_BYTES) return null
  try {
    const a = JSON.parse(new TextDecoder().decode(bytes))
    if (!Array.isArray(a) || a.length !== 10) return null
    const [v, incidentId, geohash, severity, seq, issuedAt, expiresAt, signer, note, sig] = a
    const ints = [v, severity, seq, issuedAt, expiresAt]
    if (!ints.every((n) => Number.isInteger(n) && n >= 0)) return null
    if (![incidentId, geohash, signer, note, sig].every((s) => typeof s === 'string')) return null
    if (severity > 3 || note.length > MAX_NOTE_CHARS) return null
    return { v, incidentId, geohash, severity, seq, issuedAt, expiresAt, signer, note, sig }
  } catch {
    return null
  }
}

// --- Fragmentation ----------------------------------------------------------

export function fragmentMessage(message: Uint8Array, mtu = DEFAULT_MTU): Uint8Array[] {
  const chunk = mtu - FRAGMENT_HEADER_BYTES
  if (chunk < 1) throw new RangeError('mtu too small for fragment header')
  if (message.length === 0 || message.length > MAX_MESSAGE_BYTES) throw new RangeError('message size out of range')
  const total = Math.ceil(message.length / chunk)
  if (total > MAX_FRAGMENTS) throw new RangeError('message needs too many fragments')
  const crc = crc32(message)
  const out: Uint8Array[] = []
  for (let i = 0; i < total; i++) {
    const part = message.subarray(i * chunk, (i + 1) * chunk)
    const frag = new Uint8Array(FRAGMENT_HEADER_BYTES + part.length)
    frag[0] = FRAGMENT_MAGIC
    frag[1] = BLE_BEACON_VERSION
    frag[2] = i
    frag[3] = total
    new DataView(frag.buffer).setUint32(4, crc)
    frag.set(part, FRAGMENT_HEADER_BYTES)
    out.push(frag)
  }
  return out
}

interface PartialMessage {
  total: number
  parts: Map<number, Uint8Array>
  bytes: number
  firstSeen: number
}

/** Bounded reassembly buffer: fixed partial-message count, fragment count, byte budget and age. */
export class BeaconReassembler {
  private partials = new Map<number, PartialMessage>()
  constructor(
    private readonly maxPartials = 16,
    private readonly maxAgeMs = 10_000
  ) {}

  /** Returns the full message once complete and checksum-valid, otherwise null. */
  accept(fragment: Uint8Array, nowMs: number): Uint8Array | null {
    this.evictStale(nowMs)
    if (fragment.length <= FRAGMENT_HEADER_BYTES || fragment[0] !== FRAGMENT_MAGIC) return null
    if (fragment[1] !== BLE_BEACON_VERSION) return null
    const index = fragment[2]
    const total = fragment[3]
    if (total === 0 || total > MAX_FRAGMENTS || index >= total) return null
    const id = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength).getUint32(4)
    let p = this.partials.get(id)
    if (!p) {
      if (this.partials.size >= this.maxPartials) this.dropOldest()
      p = { total, parts: new Map(), bytes: 0, firstSeen: nowMs }
      this.partials.set(id, p)
    }
    if (p.total !== total) return null
    if (!p.parts.has(index)) {
      const chunk = fragment.slice(FRAGMENT_HEADER_BYTES)
      if (p.bytes + chunk.length > MAX_MESSAGE_BYTES) {
        this.partials.delete(id)
        return null
      }
      p.parts.set(index, chunk)
      p.bytes += chunk.length
    }
    if (p.parts.size < p.total) return null
    this.partials.delete(id)
    const message = new Uint8Array(p.bytes)
    let off = 0
    for (let i = 0; i < p.total; i++) {
      const part = p.parts.get(i)!
      message.set(part, off)
      off += part.length
    }
    return crc32(message) === id ? message : null
  }

  get pending(): number {
    return this.partials.size
  }

  private evictStale(nowMs: number): void {
    for (const [id, p] of this.partials) if (nowMs - p.firstSeen > this.maxAgeMs) this.partials.delete(id)
  }

  private dropOldest(): void {
    let oldest: number | null = null
    let t = Infinity
    for (const [id, p] of this.partials) {
      if (p.firstSeen < t) {
        t = p.firstSeen
        oldest = id
      }
    }
    if (oldest !== null) this.partials.delete(oldest)
  }
}

// --- Verify-before-forward gate ---------------------------------------------

export interface RelayGateOptions {
  /** Station-provisioned signer public keys. Anything else is dropped. */
  trustedSigners: Iterable<string>
  /** Per-source token bucket: max beacons per window. */
  maxPerSourcePerWindow?: number
  windowMs?: number
}

export class BleRelayGate {
  private trusted: Set<string>
  private lastSeq = new Map<string, number>()
  private buckets = new Map<string, { count: number; windowStart: number }>()
  private readonly maxPerSource: number
  private readonly windowMs: number

  constructor(opts: RelayGateOptions) {
    this.trusted = new Set(opts.trustedSigners)
    this.maxPerSource = opts.maxPerSourcePerWindow ?? 20
    this.windowMs = opts.windowMs ?? 10_000
  }

  /** Revocation: remove a signer; its beacons are dropped from now on. */
  revoke(signer: string): void {
    this.trusted.delete(signer)
  }

  /**
   * Decide whether a beacon heard from `sourceId` may be forwarded. Unverified
   * bytes are never forwarded; replay state only advances after verification.
   */
  evaluate(beacon: Beacon | null, sourceId: string, nowMs: number): GateDecision {
    if (!this.takeToken(sourceId, nowMs)) return { forward: false, reason: 'rate-limited' }
    if (!beacon) return { forward: false, reason: 'malformed' }
    if (beacon.v !== BLE_BEACON_VERSION) return { forward: false, reason: 'version' }
    const now = Math.floor(nowMs / 1000)
    if (beacon.expiresAt <= now) return { forward: false, reason: 'expired' }
    if (beacon.issuedAt > now + MAX_CLOCK_SKEW_S) return { forward: false, reason: 'future-dated' }
    if (beacon.expiresAt - beacon.issuedAt > MAX_BEACON_TTL_S) return { forward: false, reason: 'ttl-too-long' }
    if (!this.trusted.has(beacon.signer)) return { forward: false, reason: 'untrusted-signer' }
    const { sig, ...unsigned } = beacon
    if (!verifyEd25519Signature(canonicalBeaconString(unsigned), sig, beacon.signer)) {
      return { forward: false, reason: 'bad-signature' }
    }
    const key = `${beacon.signer}:${beacon.incidentId}`
    const last = this.lastSeq.get(key)
    if (last !== undefined) {
      if (beacon.seq === last) return { forward: false, reason: 'duplicate' }
      if (beacon.seq < last) return { forward: false, reason: 'replay' }
    }
    this.lastSeq.set(key, beacon.seq)
    return { forward: true }
  }

  private takeToken(sourceId: string, nowMs: number): boolean {
    const b = this.buckets.get(sourceId)
    if (!b || nowMs - b.windowStart >= this.windowMs) {
      this.buckets.set(sourceId, { count: 1, windowStart: nowMs })
      return true
    }
    if (b.count >= this.maxPerSource) return false
    b.count++
    return true
  }
}

// --- Priority ingress -------------------------------------------------------

/** Bounded queue ordered by severity, then freshness, then fewest hops. Lowest priority is evicted first. */
export class BeaconPriorityQueue {
  private items: { beacon: Beacon; hops: number }[] = []
  constructor(private readonly capacity = 64) {}

  push(beacon: Beacon, hops: number): void {
    this.items.push({ beacon, hops })
    this.items.sort(
      (a, b) =>
        b.beacon.severity - a.beacon.severity || b.beacon.issuedAt - a.beacon.issuedAt || a.hops - b.hops
    )
    if (this.items.length > this.capacity) this.items.length = this.capacity
  }

  shift(): { beacon: Beacon; hops: number } | undefined {
    return this.items.shift()
  }

  get size(): number {
    return this.items.length
  }
}
