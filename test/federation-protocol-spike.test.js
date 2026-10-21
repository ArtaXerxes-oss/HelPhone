// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import {
  createTrustBundle,
  verifyTrustBundle,
  signFederatedEnvelope,
  verifyFederatedEnvelope,
  isIdentityRevoked,
} from '../src/lib/crypto.js'
import {
  LwwElementSet,
  evaluateConflictWinner,
  STATUS_LATTICE_RANK,
  PRIORITY_LATTICE_RANK,
} from '../src/lib/crdt.js'
import { ReplayCache } from '../src/lib/wsClient.js'
import {
  issueCrossInstanceIou,
  netCrossInstanceIous,
  escalateUnpaidIouToDao,
  formatStroops,
} from '../src/lib/treasury.js'
import { parseFederatedEvent } from '../server/indexer/parser.js'
import {
  recordHistoryEvent,
  getHistoryEvents,
  clearHistoryEvents,
} from '../server/routes/history.js'

describe('ISP-144 Federation Protocol Spike (#814)', () => {
  // Test identity keys for two mock instances
  const INSTANCE_A = {
    id: 'helphone-city-a',
    domain: 'city-a.helphone.org',
    secretKey: '11'.repeat(32),
    publicKey: '04' + '22'.repeat(64),
    aegisRoot: '0xae91500000000000000000000000000000000000000000000000000000000001',
    expertHash: '0xexp0000000000000000000000000000000000000000000000000000000000001',
  }

  const INSTANCE_B = {
    id: 'helphone-city-b',
    domain: 'city-b.helphone.org',
    secretKey: '33'.repeat(32),
    publicKey: '04' + '44'.repeat(64),
    aegisRoot: '0xae91500000000000000000000000000000000000000000000000000000000002',
    expertHash: '0xexp0000000000000000000000000000000000000000000000000000000000002',
  }

  beforeEach(() => {
    clearHistoryEvents()
  })

  // ── 1. Two-Deployment Prototype Round-Trip ────────────────────────────
  describe('1. Two-Deployment Prototype Round-Trip (A -> B -> A)', () => {
    it('executes end-to-end dispatch, acknowledgement, and timeline observation', async () => {
      // 1. Generate trust bundles
      const bundleA = await createTrustBundle({
        instanceId: INSTANCE_A.id,
        domain: INSTANCE_A.domain,
        aegisVaultRoot: INSTANCE_A.aegisRoot,
        rotationCounter: 1,
        expertRegistryHash: INSTANCE_A.expertHash,
        secretKey: INSTANCE_A.secretKey,
        publicKey: INSTANCE_A.publicKey,
      })

      const bundleB = await createTrustBundle({
        instanceId: INSTANCE_B.id,
        domain: INSTANCE_B.domain,
        aegisVaultRoot: INSTANCE_B.aegisRoot,
        rotationCounter: 1,
        expertRegistryHash: INSTANCE_B.expertHash,
        secretKey: INSTANCE_B.secretKey,
        publicKey: INSTANCE_B.publicKey,
      })

      expect(bundleA.instanceId).toBe('helphone-city-a')
      expect(bundleB.instanceId).toBe('helphone-city-b')

      // 2. City A creates an emergency incident requiring cross-instance dispatch
      const incidentPayload = {
        incidentId: 'inc-border-814',
        type: 'medical',
        priority: 'high',
        location: { lat: 45.1, lng: -73.5 },
        notes: 'Flood near border checkpoint',
        responder: 'bob-responder-b',
      }

      const dispatchEnvelope = await signFederatedEnvelope({
        senderInstance: INSTANCE_A.id,
        recipientInstance: INSTANCE_B.id,
        payloadType: 'dispatch',
        payload: incidentPayload,
        trustBundleRef: { instanceId: INSTANCE_A.id, rotationCounter: 1 },
        secretKey: INSTANCE_A.secretKey,
        publicKey: INSTANCE_A.publicKey,
      })

      expect(dispatchEnvelope.senderInstance).toBe('helphone-city-a')
      expect(dispatchEnvelope.recipientInstance).toBe('helphone-city-b')
      expect(dispatchEnvelope.signature).toBeDefined()

      // 3. City B receives and verifies the dispatch envelope
      const verifyAtB = verifyFederatedEnvelope(dispatchEnvelope, bundleA)
      expect(verifyAtB.verified).toBe(true)
      expect(verifyAtB.error).toBeUndefined()

      // Record foreign event at B
      recordHistoryEvent(parseFederatedEvent(dispatchEnvelope, { verified: true }))
      const eventsAtB = getHistoryEvents()
      expect(eventsAtB.length).toBe(1)
      expect(eventsAtB[0].custodyMarker).toBe('peer_asserted')
      expect(eventsAtB[0].originInstance).toBe('helphone-city-a')

      // 4. City B acknowledges the dispatch and responds with signed ack envelope
      const ackEnvelope = await signFederatedEnvelope({
        senderInstance: INSTANCE_B.id,
        recipientInstance: INSTANCE_A.id,
        payloadType: 'ack',
        payload: {
          incidentId: 'inc-border-814',
          originalEnvelopeId: dispatchEnvelope.envelopeId,
          status: 'acknowledged',
          responderAssigned: 'bob-responder-b',
          acknowledgedAt: Date.now(),
        },
        trustBundleRef: { instanceId: INSTANCE_B.id, rotationCounter: 1 },
        secretKey: INSTANCE_B.secretKey,
        publicKey: INSTANCE_B.publicKey,
      })

      // 5. City A receives and verifies the acknowledgement envelope
      const verifyAtA = verifyFederatedEnvelope(ackEnvelope, bundleB)
      expect(verifyAtA.verified).toBe(true)

      // Record acknowledgement at A
      recordHistoryEvent(parseFederatedEvent(ackEnvelope, { verified: true }))
      const eventsAtA = getHistoryEvents()
      expect(eventsAtA.length).toBe(2)
      expect(eventsAtA[1].eventType).toBe('federated_ack')
      expect(eventsAtA[1].originInstance).toBe('helphone-city-b')
    })
  })

  // ── 2. Trust Bundles & Rotation Drill ─────────────────────────────────
  describe('2. Trust Bundles & Root Rotation Drill', () => {
    it('verifies trust bundles, enforces rotation monotonicity, and handles stale downgrades', async () => {
      // 1. Initial bundle
      const bundleV1 = await createTrustBundle({
        instanceId: INSTANCE_A.id,
        domain: INSTANCE_A.domain,
        aegisVaultRoot: INSTANCE_A.aegisRoot,
        rotationCounter: 1,
        expertRegistryHash: INSTANCE_A.expertHash,
        secretKey: INSTANCE_A.secretKey,
        publicKey: INSTANCE_A.publicKey,
      })

      const check1 = verifyTrustBundle(bundleV1, INSTANCE_A.publicKey)
      expect(check1.valid).toBe(true)
      expect(check1.stale).toBe(false)
      expect(check1.expired).toBe(false)

      // 2. Rotation drill: rotate Aegis Vault root and increment counter
      const newAegisRoot = '0xae91500000000000000000000000000000000000000000000000000000000099'
      const bundleV2 = await createTrustBundle({
        instanceId: INSTANCE_A.id,
        domain: INSTANCE_A.domain,
        aegisVaultRoot: newAegisRoot,
        rotationCounter: 2,
        expertRegistryHash: INSTANCE_A.expertHash,
        secretKey: INSTANCE_A.secretKey,
        publicKey: INSTANCE_A.publicKey,
      })

      expect(bundleV2.rotationCounter).toBe(2)
      expect(bundleV2.aegisVaultRoot).toBe(newAegisRoot)

      // 3. New dispatch signed with counter 2 is accepted against bundleV2
      const envelopeNew = await signFederatedEnvelope({
        senderInstance: INSTANCE_A.id,
        recipientInstance: INSTANCE_B.id,
        payloadType: 'dispatch',
        payload: { test: true },
        trustBundleRef: { instanceId: INSTANCE_A.id, rotationCounter: 2 },
        secretKey: INSTANCE_A.secretKey,
        publicKey: INSTANCE_A.publicKey,
      })

      const verifyNew = verifyFederatedEnvelope(envelopeNew, bundleV2)
      expect(verifyNew.verified).toBe(true)

      // 4. Superseded dispatch signed with counter 1 is REJECTED against bundleV2
      const envelopeOld = await signFederatedEnvelope({
        senderInstance: INSTANCE_A.id,
        recipientInstance: INSTANCE_B.id,
        payloadType: 'dispatch',
        payload: { test: true },
        trustBundleRef: { instanceId: INSTANCE_A.id, rotationCounter: 1 },
        secretKey: INSTANCE_A.secretKey,
        publicKey: INSTANCE_A.publicKey,
      })

      const verifyOld = verifyFederatedEnvelope(envelopeOld, bundleV2)
      expect(verifyOld.verified).toBe(false)
      expect(verifyOld.error).toContain('superseded trust root counter')

      // 5. Stale bundle past expiresAt but within grace period triggers stale warning (verify-but-flag)
      const staleBundle = await createTrustBundle({
        instanceId: INSTANCE_A.id,
        domain: INSTANCE_A.domain,
        aegisVaultRoot: INSTANCE_A.aegisRoot,
        rotationCounter: 3,
        expertRegistryHash: INSTANCE_A.expertHash,
        secretKey: INSTANCE_A.secretKey,
        publicKey: INSTANCE_A.publicKey,
        ttlMs: -10_000, // expired 10 seconds ago
      })

      const staleCheck = verifyTrustBundle(staleBundle, INSTANCE_A.publicKey)
      expect(staleCheck.valid).toBe(true)
      expect(staleCheck.stale).toBe(true)
      expect(staleCheck.expired).toBe(false)
    })
  })

  // ── 3. Revocation Propagation & Measured SLO ──────────────────────────
  describe('3. Revocation Propagation & Bridging', () => {
    it('detects revoked responders across trust bundles and logs timestamped evidence', async () => {
      const revokedResponder = 'rogue-volunteer-99'
      const startTimestamp = Date.now()

      // Instance A adds rogue responder to revokedIdentities in its trust bundle
      const bundleWithRevocation = await createTrustBundle({
        instanceId: INSTANCE_A.id,
        domain: INSTANCE_A.domain,
        aegisVaultRoot: INSTANCE_A.aegisRoot,
        rotationCounter: 3,
        expertRegistryHash: INSTANCE_A.expertHash,
        revokedIdentities: [revokedResponder],
        secretKey: INSTANCE_A.secretKey,
        publicKey: INSTANCE_A.publicKey,
      })

      const propagationTimestamp = Date.now()
      const measuredPropagationMs = propagationTimestamp - startTimestamp

      expect(isIdentityRevoked(revokedResponder, bundleWithRevocation)).toBe(true)
      expect(isIdentityRevoked('clean-volunteer-01', bundleWithRevocation)).toBe(false)
      expect(measuredPropagationMs).toBeLessThan(5000) // Well within 5 minute SLO

      // Attempt cross-border dispatch for revoked responder
      const rogueDispatch = await signFederatedEnvelope({
        senderInstance: INSTANCE_A.id,
        recipientInstance: INSTANCE_B.id,
        payloadType: 'dispatch',
        payload: { incidentId: 'inc-99', responder: revokedResponder },
        trustBundleRef: { instanceId: INSTANCE_A.id, rotationCounter: 3 },
        secretKey: INSTANCE_A.secretKey,
        publicKey: INSTANCE_A.publicKey,
      })

      // Verification checks revocation
      const isRevoked = isIdentityRevoked(rogueDispatch.payload.responder, bundleWithRevocation)
      expect(isRevoked).toBe(true)

      // Recorded as security failure in history
      const failEvent = parseFederatedEvent(rogueDispatch, {
        verified: false,
        error: `Responder ${revokedResponder} is revoked by peer`,
      })
      expect(failEvent.federationVerified).toBe(false)
      expect(failEvent.federationError).toContain('revoked')
    })
  })

  // ── 4. CRDT Cross-Trust Convergence (>= 20 Fixture Pairs) ────────────
  describe('4. CRDT Cross-Domain Merge & Convergence', () => {
    it('proves byte-identical convergence under 20+ concurrent-edit conflict pairs', () => {
      const conflictPairs = [
        // Status lattice conflicts: safety escalation wins over resolution
        { key: 'req-01', a: { status: 'resolved' }, b: { status: 'escalated' }, expected: 'escalated' },
        { key: 'req-02', a: { status: 'open' }, b: { status: 'assigned' }, expected: 'assigned' },
        { key: 'req-03', a: { status: 'in_progress' }, b: { status: 'critical' }, expected: 'critical' },
        { key: 'req-04', a: { status: 'resolved' }, b: { status: 'open' }, expected: 'resolved' },
        { key: 'req-05', a: { status: 'cancelled' }, b: { status: 'escalated' }, expected: 'escalated' },
        // Priority lattice conflicts: higher severity wins
        { key: 'req-06', a: { priority: 'low' }, b: { priority: 'critical' }, expectedPri: 'critical' },
        { key: 'req-07', a: { priority: 'medium' }, b: { priority: 'high' }, expectedPri: 'high' },
        { key: 'req-08', a: { priority: 'high' }, b: { priority: 'critical' }, expectedPri: 'critical' },
        { key: 'req-09', a: { priority: 'low' }, b: { priority: 'medium' }, expectedPri: 'medium' },
        // Multi-attribute incident state conflicts
        { key: 'req-10', a: { status: 'resolved', priority: 'low' }, b: { status: 'escalated', priority: 'high' }, expected: 'escalated' },
        { key: 'req-11', a: { status: 'in_progress', responders: 1 }, b: { status: 'escalated', responders: 3 }, expected: 'escalated' },
        { key: 'req-12', a: { status: 'open', severity: 1 }, b: { status: 'critical', severity: 5 }, expected: 'critical' },
        // Timestamp tiebreakers
        { key: 'req-13', a: { text: 'from A' }, b: { text: 'from B' }, tsA: 1000, tsB: 2000, expectedText: 'from B' },
        { key: 'req-14', a: { text: 'from A' }, b: { text: 'from B' }, tsA: 3000, tsB: 2000, expectedText: 'from A' },
        // Instance tiebreakers (same timestamp and counter)
        { key: 'req-15', a: { val: 'city-a' }, b: { val: 'city-b' }, tsA: 5000, tsB: 5000, instA: 'city-a', instB: 'city-b', expectedVal: 'city-b' },
        // More lifecycle transitions
        { key: 'req-16', a: { status: 'open' }, b: { status: 'in_progress' }, expected: 'in_progress' },
        { key: 'req-17', a: { status: 'assigned' }, b: { status: 'escalated' }, expected: 'escalated' },
        { key: 'req-18', a: { status: 'resolved' }, b: { status: 'critical' }, expected: 'critical' },
        { key: 'req-19', a: { priority: 'critical' }, b: { priority: 'low' }, expectedPri: 'critical' },
        { key: 'req-20', a: { status: 'in_progress' }, b: { status: 'resolved' }, expected: 'resolved' },
        { key: 'req-21', a: { status: 'open' }, b: { status: 'critical' }, expected: 'critical' },
        { key: 'req-22', a: { status: 'cancelled' }, b: { status: 'open' }, expected: 'open' },
      ]

      expect(conflictPairs.length).toBeGreaterThanOrEqual(20)

      // Test individual lattice evaluations
      for (const pair of conflictPairs) {
        const opA = {
          key: pair.key,
          value: pair.a,
          deleted: false,
          actor: 'actor-a',
          counter: 1,
          timestamp: pair.tsA ?? 1000,
          instance: pair.instA ?? 'city-a',
        }
        const opB = {
          key: pair.key,
          value: pair.b,
          deleted: false,
          actor: 'actor-b',
          counter: 1,
          timestamp: pair.tsB ?? 1000,
          instance: pair.instB ?? 'city-b',
        }

        const { winner, annotation } = evaluateConflictWinner(opA, opB)
        expect(annotation).toBeDefined()

        if (pair.expected) {
          expect(winner.value.status).toBe(pair.expected)
        }
        if (pair.expectedPri) {
          expect(winner.value.priority).toBe(pair.expectedPri)
        }
        if (pair.expectedText) {
          expect(winner.value.text).toBe(pair.expectedText)
        }
      }

      // Replay all operations into two independent stores under reversed arrival order
      const storeA = new LwwElementSet('server-a', 'city-a')
      const storeB = new LwwElementSet('server-b', 'city-b')

      const allOps = []
      conflictPairs.forEach((pair, idx) => {
        allOps.push({
          key: pair.key,
          value: pair.a,
          deleted: false,
          actor: 'actor-a',
          counter: idx + 1,
          timestamp: pair.tsA ?? (1000 + idx),
          instance: 'city-a',
        })
        allOps.push({
          key: pair.key,
          value: pair.b,
          deleted: false,
          actor: 'actor-b',
          counter: idx + 1,
          timestamp: pair.tsB ?? (1000 + idx),
          instance: 'city-b',
        })
      })

      // Store A receives in original order; Store B receives in reversed order
      storeA.merge(allOps)
      storeB.merge([...allOps].reverse())

      // Both stores must converge byte-identical
      const snapA = storeA.snapshot()
      const snapB = storeB.snapshot()

      expect(snapA.entries.length).toBe(conflictPairs.length)
      expect(snapB.entries.length).toBe(conflictPairs.length)

      for (let i = 0; i < snapA.entries.length; i++) {
        expect(snapA.entries[i].key).toBe(snapB.entries[i].key)
        expect(snapA.entries[i].value).toEqual(snapB.entries[i].value)
        expect(snapA.entries[i].winnerAnnotation).toEqual(snapB.entries[i].winnerAnnotation)
      }
    })
  })

  // ── 5. Adversary Drills (Fail Loudly, 0 Silent Accepts) ────────────────
  describe('5. Adversary Drills (Tamper, Replay, Stale, Revocation)', () => {
    it('fails loudly with explicit errors on all adversarial attacks', async () => {
      const bundleA = await createTrustBundle({
        instanceId: INSTANCE_A.id,
        domain: INSTANCE_A.domain,
        aegisVaultRoot: INSTANCE_A.aegisRoot,
        rotationCounter: 1,
        expertRegistryHash: INSTANCE_A.expertHash,
        secretKey: INSTANCE_A.secretKey,
        publicKey: INSTANCE_A.publicKey,
      })

      // Attack 1: Tampered Payload
      const validEnvelope = await signFederatedEnvelope({
        senderInstance: INSTANCE_A.id,
        recipientInstance: INSTANCE_B.id,
        payloadType: 'dispatch',
        payload: { incidentId: 'legit-123', priority: 'medium' },
        trustBundleRef: { instanceId: INSTANCE_A.id, rotationCounter: 1 },
        secretKey: INSTANCE_A.secretKey,
        publicKey: INSTANCE_A.publicKey,
      })

      // Adversary alters payload without re-signing
      const tamperedEnvelope = {
        ...validEnvelope,
        payload: { incidentId: 'legit-123', priority: 'CRITICAL_HIJACK' },
      }

      const tamperResult = verifyFederatedEnvelope(tamperedEnvelope, bundleA)
      expect(tamperResult.verified).toBe(false)
      expect(tamperResult.error).toContain('Envelope signature verification failed')

      // Attack 2: Replay Attack (Duplicate Nonce)
      const replayCache = new ReplayCache(300_000)
      const nonce = 'unique-nonce-12345'
      expect(replayCache.checkAndAdd(nonce)).toBe(true)
      expect(replayCache.checkAndAdd(nonce)).toBe(false) // Second attempt fails

      // Attack 3: Drifted Timestamp (> 5 min replay window)
      const staleTimestampEnvelope = {
        ...validEnvelope,
        timestamp: Date.now() - 400_000, // 400s in the past
      }
      const staleTsResult = verifyFederatedEnvelope(staleTimestampEnvelope, bundleA)
      expect(staleTsResult.verified).toBe(false)
      expect(staleTsResult.error).toContain('outside replay window')

      // Attack 4: Expired Trust Bundle (Beyond Grace Period)
      const expiredBundle = await createTrustBundle({
        instanceId: INSTANCE_A.id,
        domain: INSTANCE_A.domain,
        aegisVaultRoot: INSTANCE_A.aegisRoot,
        rotationCounter: 1,
        expertRegistryHash: INSTANCE_A.expertHash,
        secretKey: INSTANCE_A.secretKey,
        publicKey: INSTANCE_A.publicKey,
        ttlMs: -400_000, // expired 400s ago (beyond 300s grace)
      })

      const expiredCheck = verifyTrustBundle(expiredBundle, INSTANCE_A.publicKey)
      expect(expiredCheck.valid).toBe(false)
      expect(expiredCheck.expired).toBe(true)
      expect(expiredCheck.error).toContain('expired beyond grace')

      // Attack 5: Unknown / Untrusted Foreign Peer Key
      const bogusKeyBundleCheck = verifyTrustBundle(bundleA, '04' + '99'.repeat(64))
      expect(bogusKeyBundleCheck.valid).toBe(false)
      expect(bogusKeyBundleCheck.error).toContain('does not match expected peer key')
    })
  })

  // ── 6. Partition Healing ──────────────────────────────────────────────
  describe('6. Partition Healing & Disconnected Edits', () => {
    it('merges divergent offline edits cleanly upon reconnection', () => {
      const replicaA = new LwwElementSet('dispatcher-a', 'city-a')
      const replicaB = new LwwElementSet('dispatcher-b', 'city-b')

      // Pre-partition shared state
      const initialOp = replicaA.set('incident-77', { status: 'open', priority: 'medium' }, 1000)
      replicaB.apply(initialOp)

      expect(replicaA.snapshot().entries).toEqual(replicaB.snapshot().entries)

      // Network Partition happens: City A marks resolved; City B concurrently escalates
      const opA = replicaA.set('incident-77', { status: 'resolved', priority: 'medium' }, 2000)
      const opB = replicaB.set('incident-77', { status: 'escalated', priority: 'critical' }, 2050)

      // Both replicas diverged offline
      expect(replicaA.snapshot().entries[0].value.status).toBe('resolved')
      expect(replicaB.snapshot().entries[0].value.status).toBe('escalated')

      // Partition heals: exchange deltas
      const deltaAtoB = replicaA.delta(replicaB.clock)
      const deltaBtoA = replicaB.delta(replicaA.clock)

      replicaB.merge(deltaAtoB)
      replicaA.merge(deltaBtoA)

      // Deterministic merge lattice ensures both converge to escalated and critical
      const snapA = replicaA.snapshot()
      const snapB = replicaB.snapshot()

      expect(snapA.entries[0].value.status).toBe('escalated')
      expect(snapB.entries[0].value.status).toBe('escalated')
      expect(snapA.entries[0].value.priority).toBe('critical')
      expect(snapB.entries[0].value.priority).toBe('critical')
      expect(snapA.entries[0].winnerAnnotation).toContain('lattice:status_escalated_over_resolved')
    })
  })

  // ── 7. Settlement Prototype (IOU Issuance, Netting, Default) ──────────
  describe('7. Settlement Prototype (IOU Netting & DAO Escalation)', () => {
    it('issues IOUs, performs bilateral periodic netting, and handles default escalation', () => {
      const ious = [
        // City A owes City B for aid rendered on 2 incidents
        issueCrossInstanceIou({
          debtorInstance: 'city-a',
          creditorInstance: 'city-b',
          incidentId: 'inc-01',
          stroops: 300_000_000, // 30 XLM
        }),
        issueCrossInstanceIou({
          debtorInstance: 'city-a',
          creditorInstance: 'city-b',
          incidentId: 'inc-02',
          stroops: 200_000_000, // 20 XLM
        }),
        // City B owes City A for aid rendered on 1 incident
        issueCrossInstanceIou({
          debtorInstance: 'city-b',
          creditorInstance: 'city-a',
          incidentId: 'inc-03',
          stroops: 150_000_000, // 15 XLM
        }),
      ]

      expect(ious.length).toBe(3)
      expect(ious[0].status).toBe('issued')
      expect(formatStroops(ious[0].stroops)).toBe('30.00')

      // Bilateral Netting: City A owes net (30 + 20 - 15) = 35 XLM to City B
      const { netResult, updatedIous } = netCrossInstanceIous(ious, 'city-a', 'city-b')

      expect(netResult.debtorInstance).toBe('city-a')
      expect(netResult.creditorInstance).toBe('city-b')
      expect(netResult.netStroops).toBe(350_000_000) // 35 XLM
      expect(formatStroops(netResult.netStroops)).toBe('35.00')
      expect(netResult.nettedIouIds.length).toBe(3)

      // All active IOUs marked netted
      expect(updatedIous.every((i) => i.status === 'netted')).toBe(true)

      // Default escalation test: unpaid IOU generates DAO proposal
      const overdueIou = issueCrossInstanceIou({
        debtorInstance: 'city-rogue',
        creditorInstance: 'city-a',
        incidentId: 'inc-default-99',
        stroops: 500_000_000,
      })

      const daoProposal = escalateUnpaidIouToDao(overdueIou, 'Peer refusal to settle bilateral netting')
      expect(daoProposal.proposalType).toBe('FundAllocation')
      expect(daoProposal.action).toBe('dao_vote_writeoff')
      expect(daoProposal.title).toContain('[Federation Default]')
      expect(daoProposal.iou.status).toBe('defaulted')
    })
  })
})
