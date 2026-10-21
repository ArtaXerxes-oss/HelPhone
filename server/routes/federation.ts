/**
 * Federation Protocol v0 Route Handler (ISP-144)
 *
 * Implements cross-instance dispatch, trust-bundle gossip, mutual authentication,
 * CRDT delta exchange, and IOU aid settlement without a central server.
 */
import { Router, Request, Response } from 'express'
import {
  createTrustBundle,
  verifyTrustBundle,
  signFederatedEnvelope,
  verifyFederatedEnvelope,
  isIdentityRevoked,
} from '../../src/lib/crypto.js'
import type { TrustBundle, FederatedEnvelope } from '../../src/lib/crypto.js'
import { ReplayCache } from '../../src/lib/wsClient.js'
import { parseFederatedEvent } from '../indexer/parser.js'
import { recordHistoryEvent } from './history.js'
import { localCrdtStore } from './sync.js'
import {
  issueCrossInstanceIou,
  netCrossInstanceIous,
  escalateUnpaidIouToDao,
} from '../../src/lib/treasury.js'
import type { CrossInstanceIou } from '../../src/lib/treasury.js'

export interface FederationRouterOptions {
  instanceId?: string
  domain?: string
  aegisVaultRoot?: string
  secretKey?: string
  publicKey?: string
  rotationCounter?: number
}

// In-memory peer state stores
const peerTrustBundles = new Map<string, TrustBundle>()
const replayCache = new ReplayCache(300_000)
const iouStore = new Map<string, CrossInstanceIou>()
const revocationAuditLog: Array<{ identity: string; revokedAt: number; sourceInstance: string }> = []

export function createFederationRouter(options: FederationRouterOptions = {}) {
  const router = Router()

  const instanceId = options.instanceId || process.env.INSTANCE_ID || 'helphone-instance-a'
  const domain = options.domain || process.env.FEDERATION_DOMAIN || 'instance-a.helphone.org'
  let aegisVaultRoot = options.aegisVaultRoot || '0xae91500000000000000000000000000000000000000000000000000000000001'
  let rotationCounter = options.rotationCounter ?? 1
  const expertRegistryHash = '0xexp7890000000000000000000000000000000000000000000000000000000001'
  const localRevocations = new Set<string>()

  // Deterministic local authority keypair fallback for testing
  const secretKey = options.secretKey || process.env.FEDERATION_SECRET_KEY || '11'.repeat(32)
  const publicKey = options.publicKey || process.env.FEDERATION_PUBLIC_KEY || '04' + '22'.repeat(64)

  async function getLocalTrustBundle(): Promise<TrustBundle> {
    return createTrustBundle({
      instanceId,
      domain,
      aegisVaultRoot,
      rotationCounter,
      expertRegistryHash,
      revokedIdentities: [...localRevocations],
      secretKey,
      publicKey,
      ttlMs: 3600_000,
    })
  }

  // ── 1. Trust Bundle Export & Gossip Endpoints ─────────────────────────

  router.get('/trust-bundle', async (_req: Request, res: Response) => {
    try {
      const bundle = await getLocalTrustBundle()
      res.json({ success: true, trustBundle: bundle })
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message })
    }
  })

  router.post('/trust-bundle/gossip', async (req: Request, res: Response) => {
    try {
      const incomingBundle: TrustBundle = req.body?.trustBundle
      if (!incomingBundle || !incomingBundle.instanceId) {
        return res.status(400).json({ success: false, error: 'Missing or malformed trustBundle' })
      }

      const existing = peerTrustBundles.get(incomingBundle.instanceId)
      if (existing && incomingBundle.rotationCounter < existing.rotationCounter) {
        return res.status(409).json({
          success: false,
          error: `Stale rotation counter: received ${incomingBundle.rotationCounter}, have ${existing.rotationCounter}`,
        })
      }

      const verification = verifyTrustBundle(incomingBundle, incomingBundle.signingPublicKey)
      if (!verification.valid) {
        return res.status(403).json({ success: false, error: verification.error })
      }

      // Check if any identities were newly revoked in this bundle update
      const prevRevoked = new Set(existing?.revokedIdentities || [])
      for (const rev of incomingBundle.revokedIdentities || []) {
        if (!prevRevoked.has(rev)) {
          revocationAuditLog.push({
            identity: rev,
            revokedAt: Date.now(),
            sourceInstance: incomingBundle.instanceId,
          })
        }
      }

      peerTrustBundles.set(incomingBundle.instanceId, incomingBundle)

      res.json({
        success: true,
        message: 'Trust bundle accepted and stored',
        instanceId: incomingBundle.instanceId,
        rotationCounter: incomingBundle.rotationCounter,
        staleWarning: verification.stale,
      })
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message })
    }
  })

  // ── 2. Cross-Instance Dispatch & Acknowledgement ──────────────────────

  router.post('/dispatch', async (req: Request, res: Response) => {
    try {
      const envelope: FederatedEnvelope = req.body?.envelope
      if (!envelope) {
        return res.status(400).json({ success: false, error: 'Missing federated envelope' })
      }

      const peerBundle = peerTrustBundles.get(envelope.senderInstance)
      if (!peerBundle) {
        return res.status(403).json({
          success: false,
          error: `Untrusted peer instance '${envelope.senderInstance}': no trust bundle on record`,
        })
      }

      // 1. Replay window and nonce protection
      if (!replayCache.checkAndAdd(envelope.nonce, envelope.timestamp)) {
        return res.status(409).json({
          success: false,
          error: `Replay detected: duplicate nonce '${envelope.nonce}' or expired replay window`,
        })
      }

      // 2. Cryptographic signature and envelope verification
      const verifyOutcome = verifyFederatedEnvelope(envelope, peerBundle)
      if (!verifyOutcome.verified) {
        // Record failed attempt in history with custody marker and alert
        recordHistoryEvent(
          parseFederatedEvent(envelope, { verified: false, error: verifyOutcome.error })
        )
        return res.status(401).json({
          success: false,
          error: `Envelope verification failed: ${verifyOutcome.error}`,
        })
      }

      // 3. Revocation check for foreign responder or sender nullifier
      const responder = envelope.payload?.responder || envelope.payload?.responderAddress
      if (responder && isIdentityRevoked(responder, peerBundle)) {
        recordHistoryEvent(
          parseFederatedEvent(envelope, { verified: false, error: `Responder ${responder} is revoked by peer` })
        )
        return res.status(403).json({
          success: false,
          error: `Responder '${responder}' has been revoked by peer instance ${peerBundle.instanceId}`,
        })
      }

      // 4. Record foreign-origin dispatch in history with custody markers
      recordHistoryEvent(parseFederatedEvent(envelope, { verified: true }))

      // 5. Build signed acknowledgement envelope
      const localBundle = await getLocalTrustBundle()
      const ackEnvelope = await signFederatedEnvelope({
        senderInstance: instanceId,
        recipientInstance: envelope.senderInstance,
        payloadType: 'ack',
        payload: {
          originalEnvelopeId: envelope.envelopeId,
          incidentId: envelope.payload?.incidentId || envelope.payload?.id,
          status: 'acknowledged',
          responderAssigned: responder || 'local-volunteer',
          acknowledgedAt: Date.now(),
        },
        trustBundleRef: {
          instanceId,
          rotationCounter: localBundle.rotationCounter,
        },
        secretKey,
        publicKey,
      })

      res.json({
        success: true,
        message: 'Federated dispatch accepted and verified',
        staleBundleFlag: verifyOutcome.staleBundle,
        ackEnvelope,
      })
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message })
    }
  })

  router.post('/ack', async (req: Request, res: Response) => {
    try {
      const envelope: FederatedEnvelope = req.body?.envelope
      if (!envelope) {
        return res.status(400).json({ success: false, error: 'Missing ack envelope' })
      }

      const peerBundle = peerTrustBundles.get(envelope.senderInstance)
      if (!peerBundle) {
        return res.status(403).json({ success: false, error: 'Untrusted peer instance' })
      }

      if (!replayCache.checkAndAdd(envelope.nonce, envelope.timestamp)) {
        return res.status(409).json({ success: false, error: 'Replay detected on ack envelope' })
      }

      const verifyOutcome = verifyFederatedEnvelope(envelope, peerBundle)
      if (!verifyOutcome.verified) {
        recordHistoryEvent(parseFederatedEvent(envelope, { verified: false, error: verifyOutcome.error }))
        return res.status(401).json({ success: false, error: verifyOutcome.error })
      }

      // Record acknowledgement event in history with peer custody marker
      recordHistoryEvent(parseFederatedEvent(envelope, { verified: true }))

      res.json({
        success: true,
        message: 'Cross-instance acknowledgement observed and verified',
        staleBundleFlag: verifyOutcome.staleBundle,
      })
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message })
    }
  })

  // ── 3. CRDT Peer Delta Exchange ───────────────────────────────────────

  router.post('/sync', async (req: Request, res: Response) => {
    try {
      const envelope: FederatedEnvelope = req.body?.envelope
      if (!envelope || envelope.payloadType !== 'crdt_delta') {
        return res.status(400).json({ success: false, error: 'Invalid or missing crdt_delta envelope' })
      }

      const peerBundle = peerTrustBundles.get(envelope.senderInstance)
      if (!peerBundle) {
        return res.status(403).json({ success: false, error: 'Unknown peer for CRDT sync' })
      }

      const verifyOutcome = verifyFederatedEnvelope(envelope, peerBundle)
      if (!verifyOutcome.verified) {
        return res.status(401).json({ success: false, error: verifyOutcome.error })
      }

      const operations = envelope.payload?.operations || []
      let applied = 0
      for (const op of operations) {
        const namespaced = {
          ...op,
          instance: envelope.senderInstance,
          provenance: 'peer_asserted' as const,
        }
        if (localCrdtStore.apply(namespaced)) {
          applied++
        }
      }

      const localClock = localCrdtStore.clock
      const returnDeltas = localCrdtStore.delta(envelope.payload?.vectorClock || {})

      const localBundle = await getLocalTrustBundle()
      const responseEnvelope = await signFederatedEnvelope({
        senderInstance: instanceId,
        recipientInstance: envelope.senderInstance,
        payloadType: 'crdt_delta',
        payload: {
          operations: returnDeltas,
          vectorClock: localClock,
        },
        trustBundleRef: {
          instanceId,
          rotationCounter: localBundle.rotationCounter,
        },
        secretKey,
        publicKey,
      })

      res.json({
        success: true,
        appliedCount: applied,
        responseEnvelope,
      })
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message })
    }
  })

  // ── 4. Cross-Instance Settlement & IOU Netting ────────────────────────

  router.post('/settlement', async (req: Request, res: Response) => {
    try {
      const { action, incidentId, debtorInstance, creditorInstance, stroops, defaultReason } = req.body || {}

      if (action === 'issue') {
        if (!incidentId || !debtorInstance || !creditorInstance || !stroops) {
          return res.status(400).json({ success: false, error: 'Missing IOU creation fields' })
        }
        const iou = issueCrossInstanceIou({
          incidentId,
          debtorInstance,
          creditorInstance,
          stroops: Number(stroops),
        })
        iouStore.set(iou.iouId, iou)
        return res.json({ success: true, message: 'Cross-instance IOU issued', iou })
      }

      if (action === 'net') {
        const ious = [...iouStore.values()]
        const { netResult, updatedIous } = netCrossInstanceIous(
          ious,
          debtorInstance || instanceId,
          creditorInstance || 'peer'
        )
        for (const u of updatedIous) {
          iouStore.set(u.iouId, u)
        }
        return res.json({ success: true, netResult, remainingIous: updatedIous })
      }

      if (action === 'escalate_default') {
        const iou = iouStore.get(req.body?.iouId)
        if (!iou) {
          return res.status(404).json({ success: false, error: 'IOU not found' })
        }
        const escalation = escalateUnpaidIouToDao(iou, defaultReason)
        iouStore.set(escalation.iou.iouId, escalation.iou)
        return res.json({
          success: true,
          message: 'Defaulted IOU escalated to DAO proposal',
          escalation,
        })
      }

      res.status(400).json({ success: false, error: `Unknown action: ${action}` })
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message })
    }
  })

  // ── 5. Federation Status & Maintenance ─────────────────────────────────

  router.get('/status', async (_req: Request, res: Response) => {
    res.json({
      instanceId,
      domain,
      aegisVaultRoot,
      rotationCounter,
      activePeerTrustBundles: [...peerTrustBundles.keys()].map((k) => ({
        instanceId: k,
        rotationCounter: peerTrustBundles.get(k)?.rotationCounter,
        expiresAt: peerTrustBundles.get(k)?.expiresAt,
        revokedCount: peerTrustBundles.get(k)?.revokedIdentities.length || 0,
      })),
      replayCacheEntries: replayCache.size(),
      activeIousCount: [...iouStore.values()].filter((i) => i.status === 'issued').length,
      revocationAuditCount: revocationAuditLog.length,
    })
  })

  // Helper for test drills: rotate local trust root
  router.post('/test/rotate-root', (req: Request, res: Response) => {
    rotationCounter++
    if (req.body?.newRoot) {
      aegisVaultRoot = req.body.newRoot
    }
    res.json({ success: true, rotationCounter, aegisVaultRoot })
  })

  // Helper for test drills: revoke identity locally
  router.post('/test/revoke-identity', (req: Request, res: Response) => {
    const { identity } = req.body || {}
    if (!identity) {
      return res.status(400).json({ error: 'identity required' })
    }
    localRevocations.add(identity)
    res.json({ success: true, revokedCount: localRevocations.size })
  })

  return router
}

export default createFederationRouter
