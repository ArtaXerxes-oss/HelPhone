// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { generateEd25519Keypair } from '../src/lib/crypto.js'
import {
  BeaconPriorityQueue,
  BeaconReassembler,
  BleRelayGate,
  crc32,
  decodeBeacon,
  encodeBeacon,
  fragmentMessage,
  isBleGossipEnabled,
  isPayloadAllowedOnBearer,
  signBeacon,
  FRAGMENT_HEADER_BYTES,
  MAX_BEACON_TTL_S,
} from '../src/lib/bleRelay.js'

describe('ISP-113 BLE gossip spike (#783): beacon v0 unit harness', () => {
  const NOW_S = 1_800_000_000
  const NOW_MS = NOW_S * 1000
  let station
  let gate

  const make = (over = {}, kp = station) =>
    signBeacon(
      {
        v: 0,
        incidentId: 'inc-1',
        geohash: 'u4pruydqq',
        severity: 3,
        seq: 1,
        issuedAt: NOW_S,
        expiresAt: NOW_S + 300,
        note: 'wing C collapse',
        ...over,
      },
      kp.publicKey,
      kp.secretKey
    )

  beforeEach(() => {
    station = generateEd25519Keypair()
    gate = new BleRelayGate({ trustedSigners: [station.publicKey] })
  })

  describe('flag and bearer policy', () => {
    it('is off unless VITE_BLE_GOSSIP is enabled', () => {
      expect(isBleGossipEnabled({})).toBe(false)
      expect(isBleGossipEnabled({ VITE_BLE_GOSSIP: 'false' })).toBe(false)
      expect(isBleGossipEnabled({ VITE_BLE_GOSSIP: 'true' })).toBe(true)
    })

    it('embargoes telemetry and bulk CRDT on the ble-trickle bearer', () => {
      expect(isPayloadAllowedOnBearer('telemetry', 'ble-trickle')).toBe(false)
      expect(isPayloadAllowedOnBearer('crdt-bulk', 'ble-trickle')).toBe(false)
      expect(isPayloadAllowedOnBearer('incident-beacon', 'ble-trickle')).toBe(true)
      expect(isPayloadAllowedOnBearer('telemetry', 'broadband')).toBe(true)
    })
  })

  describe('crc32', () => {
    it('matches the standard check value', () => {
      expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    })
  })

  describe('fragment / reassemble', () => {
    it('round-trips a signed beacon across 20-byte MTU fragments', () => {
      const beacon = make()
      const frags = fragmentMessage(encodeBeacon(beacon))
      expect(frags.length).toBeGreaterThan(1)
      expect(frags.every((f) => f.length <= 20)).toBe(true)
      const r = new BeaconReassembler()
      let out = null
      for (const f of [...frags].reverse()) out = r.accept(f, NOW_MS) ?? out
      expect(decodeBeacon(out)).toEqual(beacon)
      expect(r.pending).toBe(0)
    })

    it('tolerates duplicate fragments', () => {
      const frags = fragmentMessage(encodeBeacon(make()))
      const r = new BeaconReassembler()
      r.accept(frags[0], NOW_MS)
      r.accept(frags[0], NOW_MS)
      let out = null
      for (const f of frags) out = r.accept(f, NOW_MS) ?? out
      expect(out).not.toBeNull()
    })

    it('rejects a message whose checksum does not match', () => {
      const frags = fragmentMessage(encodeBeacon(make()))
      frags[0][FRAGMENT_HEADER_BYTES] ^= 0xff
      const r = new BeaconReassembler()
      let out = null
      for (const f of frags) out = r.accept(f, NOW_MS) ?? out
      expect(out).toBeNull()
    })

    it('rejects bad magic, bad version and out-of-range indexes', () => {
      const r = new BeaconReassembler()
      const f = fragmentMessage(encodeBeacon(make()))[0]
      const bad = (i, v) => {
        const c = f.slice()
        c[i] = v
        return c
      }
      expect(r.accept(bad(0, 0x00), NOW_MS)).toBeNull()
      expect(r.accept(bad(1, 9), NOW_MS)).toBeNull()
      expect(r.accept(bad(2, 200), NOW_MS)).toBeNull()
      expect(r.pending).toBe(0)
    })

    it('bounds partial buffers and drops stale ones', () => {
      const r = new BeaconReassembler(2, 1000)
      for (let i = 0; i < 5; i++) {
        const frags = fragmentMessage(encodeBeacon(make({ incidentId: `inc-${i}` })))
        r.accept(frags[0], NOW_MS + i)
      }
      expect(r.pending).toBe(2)
      r.accept(fragmentMessage(encodeBeacon(make()))[0], NOW_MS + 5000)
      expect(r.pending).toBe(1)
    })

    it('refuses oversized or empty messages', () => {
      expect(() => fragmentMessage(new Uint8Array(0))).toThrow(RangeError)
      expect(() => fragmentMessage(new Uint8Array(5000))).toThrow(RangeError)
      expect(() => fragmentMessage(new Uint8Array(10), 8)).toThrow(RangeError)
    })
  })

  describe('decodeBeacon', () => {
    it('returns null for malformed input instead of throwing', () => {
      const enc = (v) => new TextEncoder().encode(JSON.stringify(v))
      expect(decodeBeacon(new Uint8Array(0))).toBeNull()
      expect(decodeBeacon(enc({ a: 1 }))).toBeNull()
      expect(decodeBeacon(enc([0, 'a', 'b', 9, 1, 1, 2, 's', 'n', 'x']))).toBeNull()
      expect(decodeBeacon(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull()
    })
  })

  describe('verify-before-forward', () => {
    it('forwards a valid beacon from a trusted signer', () => {
      expect(gate.evaluate(make(), 'peer-a', NOW_MS)).toEqual({ forward: true })
    })

    it('drops an invalid signature (tampered severity)', () => {
      const forged = { ...make({ severity: 1 }), severity: 0 }
      expect(gate.evaluate(forged, 'peer-a', NOW_MS)).toEqual({ forward: false, reason: 'bad-signature' })
    })

    it('drops a spoofed "all clear" signed by an untrusted key', () => {
      const attacker = generateEd25519Keypair()
      const spoof = make({ severity: 0, note: 'all clear' }, attacker)
      expect(gate.evaluate(spoof, 'peer-x', NOW_MS)).toEqual({ forward: false, reason: 'untrusted-signer' })
    })

    it('drops expired, future-dated and over-long-lived beacons', () => {
      expect(gate.evaluate(make({ issuedAt: NOW_S - 600, expiresAt: NOW_S - 1 }), 'a', NOW_MS)).toEqual({
        forward: false,
        reason: 'expired',
      })
      expect(gate.evaluate(make({ issuedAt: NOW_S + 3600, expiresAt: NOW_S + 3900 }), 'a', NOW_MS)).toEqual({
        forward: false,
        reason: 'future-dated',
      })
      expect(
        gate.evaluate(make({ expiresAt: NOW_S + MAX_BEACON_TTL_S + 1 }), 'a', NOW_MS)
      ).toEqual({ forward: false, reason: 'ttl-too-long' })
    })

    it('drops an unknown version and null (undecodable) input', () => {
      expect(gate.evaluate(make({ v: 7 }), 'a', NOW_MS)).toEqual({ forward: false, reason: 'version' })
      expect(gate.evaluate(null, 'a', NOW_MS)).toEqual({ forward: false, reason: 'malformed' })
    })

    it('dedups the same beacon heard via several relays', () => {
      const b = make()
      expect(gate.evaluate(b, 'relay-1', NOW_MS).forward).toBe(true)
      expect(gate.evaluate(b, 'relay-2', NOW_MS)).toEqual({ forward: false, reason: 'duplicate' })
      expect(gate.evaluate(b, 'relay-3', NOW_MS)).toEqual({ forward: false, reason: 'duplicate' })
    })

    it('rejects a replayed older sequence and accepts a newer one', () => {
      expect(gate.evaluate(make({ seq: 5 }), 'a', NOW_MS).forward).toBe(true)
      expect(gate.evaluate(make({ seq: 4 }), 'a', NOW_MS)).toEqual({ forward: false, reason: 'replay' })
      expect(gate.evaluate(make({ seq: 6 }), 'a', NOW_MS).forward).toBe(true)
    })

    it('does not advance replay state for beacons that fail verification', () => {
      const forged = { ...make({ seq: 99 }), note: 'tampered' }
      expect(gate.evaluate(forged, 'a', NOW_MS).forward).toBe(false)
      expect(gate.evaluate(make({ seq: 1 }), 'a', NOW_MS).forward).toBe(true)
    })

    it('stops forwarding a signer after revocation', () => {
      gate.revoke(station.publicKey)
      expect(gate.evaluate(make(), 'a', NOW_MS)).toEqual({ forward: false, reason: 'untrusted-signer' })
    })

    it('rate-limits a flooding source without affecting others', () => {
      const small = new BleRelayGate({ trustedSigners: [station.publicKey], maxPerSourcePerWindow: 3, windowMs: 1000 })
      const results = Array.from({ length: 6 }, (_, i) => small.evaluate(make({ seq: i + 1 }), 'spammer', NOW_MS))
      expect(results.filter((r) => !r.forward && r.reason === 'rate-limited')).toHaveLength(3)
      expect(small.evaluate(make({ incidentId: 'other' }), 'honest', NOW_MS).forward).toBe(true)
      expect(small.evaluate(make({ seq: 50 }), 'spammer', NOW_MS + 1000).forward).toBe(true)
    })
  })

  describe('priority ingress', () => {
    it('delivers life-safety beacons first from a 500-beacon flood and stays bounded', () => {
      const q = new BeaconPriorityQueue(64)
      for (let i = 0; i < 500; i++) {
        q.push(make({ incidentId: `inc-${i}`, severity: i === 321 ? 3 : 0, issuedAt: NOW_S + (i % 10) }), 1)
      }
      expect(q.size).toBe(64)
      expect(q.shift().beacon.incidentId).toBe('inc-321')
    })

    it('orders equal severity by freshness, then fewer hops', () => {
      const q = new BeaconPriorityQueue()
      q.push(make({ incidentId: 'old', issuedAt: NOW_S - 10 }), 1)
      q.push(make({ incidentId: 'far', issuedAt: NOW_S }), 4)
      q.push(make({ incidentId: 'near', issuedAt: NOW_S }), 1)
      expect([q.shift(), q.shift(), q.shift()].map((x) => x.beacon.incidentId)).toEqual(['near', 'far', 'old'])
    })
  })
})
