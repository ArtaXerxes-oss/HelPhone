# HelPhone Federation Protocol Specification (v0)
**Document ID:** ISP-144-FED-01  
**Status:** Implemented / Prototype Green  
**Subsystems:** `server/routes/federation.ts`, `src/lib/crdt.ts`, `src/lib/crypto.ts`, `src/lib/treasury.ts`, `server/indexer/parser.ts`, `src/components/ProvenanceBadge.jsx`

---

## 1. Executive Summary & Core Invariant

The HelPhone Federation Protocol allows two completely independent HelPhone deployments—each running in its own cloud project (e.g. Render), backed by separate PostgreSQL instances, anchoring identity in independent Soroban smart contracts (`contracts/aegis_vault/` and `contracts/helphone_dao/`), and managing their own responder rosters—to interoperate seamlessly during border-straddling emergencies without surrendering sovereignty to any central server or coordinator.

### Core Invariant
> No foreign assertion is ever rendered as local truth without explicit cryptographic provenance, and no cross-instance dispatch is processed without mutual authentication, replay mitigation, and revocation checks against the originating instance's trust bundle.

---

## 2. Protocol Architecture

```
+------------------------------------+           +------------------------------------+
|       Deployment A (City A)        |           |       Deployment B (City B)        |
|  - Postgres A (server/db/)         |           |  - Postgres B (server/db/)         |
|  - Aegis Vault A (Soroban)         |           |  - Aegis Vault B (Soroban)         |
|  - DAO A (Treasury A)              |           |  - DAO B (Treasury B)              |
|                                    |           |                                    |
| [Trust Bundle A]                   |  Gossip   | [Trust Bundle B]                   |
| (Root A, Counter N, Revocations)   | --------> | (Root B, Counter M, Revocations)   |
|                                    |           |                                    |
| [Dispatch Router]                  |  Dispatch | [Federation Ingestion]             |
|   Creates Incident & Envelope      | --------> |   Verifies Sig, Checks Replay/Rev. |
|                                    |           |   Assigns Local Responder          |
|                                    |    Ack    |                                    |
|   Observes Acknowledgement         | <-------- |   Returns Signed Ack Envelope      |
|   Updates Timeline (Peer Custody)  |           |   Updates Timeline (Peer Custody)  |
|                                    |           |                                    |
| [CRDT Sync Node A]                 | DeltaSync | [CRDT Sync Node B]                 |
|   instance-a:actor:counter         | <=======> |   instance-b:actor:counter         |
|   Deterministic Lattice Merge      |           |   Deterministic Lattice Merge      |
|                                    |           |                                    |
| [Treasury A (IOU Store)]           |  Netting  | [Treasury B (IOU Store)]           |
|   Issues Aid IOU                   | < - - - > |   Bilateral Netting / DAO Proposals|
+------------------------------------+           +------------------------------------+
```

---

## 3. Cryptographic Envelope & Trust Bundle Schemas

### 3.1 Trust Bundle Schema
A trust bundle encapsulates an instance's current cryptographic authority and identity state:

```typescript
export interface TrustBundle {
  instanceId: string;            // e.g. "helphone-city-a"
  domain: string;                // e.g. "city-a.helphone.org"
  aegisVaultRoot: string;        // Current root commitment in contracts/aegis_vault
  rotationCounter: number;       // Monotonically increasing root counter (starts at 1)
  expertRegistryHash: string;    // Merkle root / hash of active responder certifications
  revokedIdentities: string[];   // Blacklist of revoked nullifiers / responder keys
  issuedAt: number;              // Millisecond Unix epoch
  expiresAt: number;             // Expiry epoch (default TTL: 1 hour)
  signature: string;             // Authority Ed25519 signature of canonical JSON
  signingPublicKey: string;      // Instance authority public key
}
```

#### Stale Bundle Downgrade Policy
1. **Fresh (`now <= expiresAt`):** Trusted fully.
2. **Stale within Grace (`expiresAt < now <= expiresAt + 300_000`):** Downgraded to **"verify-but-flag"**. Incoming envelopes are verified cryptographically, but events are marked with `staleWarning: true` and surfaced to dispatchers with cautionary UI copy.
3. **Expired beyond Grace (`now > expiresAt + 300_000`):** Hard rejection (`403 Forbidden: Trust bundle has expired beyond grace period`).

### 3.2 Federated Envelope Schema
All cross-instance protocol messages (dispatch, ack, crdt_delta, settlement_iou) use the v1.0 signed envelope:

```typescript
export interface FederatedEnvelope<T = unknown> {
  version: "1.0";
  envelopeId: string;            // Format: `${senderInstance}:${timestamp}:${nonce[0..8]}`
  senderInstance: string;        // Originating deployment ID
  recipientInstance: string;     // Intended recipient deployment ID
  nonce: string;                 // 128-bit cryptographically secure random hex
  timestamp: number;             // Millisecond timestamp
  trustBundleRef: {
    instanceId: string;
    rotationCounter: number;     // Must match or exceed peer's active rotation counter
  };
  payloadType: "dispatch" | "ack" | "status_update" | "crdt_delta" | "settlement_iou";
  payload: T;                    // Type-specific structured message payload
  idempotencyKey: string;        // Format: `${senderInstance}:${nonce}`
  signature: string;             // Signature over canonicalJson(envelopeWithoutSignature)
  senderPublicKey: string;       // Public key matching the sender's active trust bundle
}
```

---

## 4. Replay Protection & Transport

### 4.1 Replay Window & Nonce Cache
- Each deployment runs a rolling `ReplayCache` with a 300,000 ms (5-minute) retention window.
- Any envelope whose timestamp drifts by $> 300$ seconds from the receiver's local clock is rejected immediately (`401 Envelope timestamp outside replay window`).
- Duplicate nonces within the window trigger an explicit `409 Conflict: Replay detected`.

### 4.2 Transport Layer
1. **Direct HTTP/HTTPS:** Standard REST endpoints mounted at `/api/federation/*`.
2. **WebRTC Direct Data Channels:** Peer-to-peer authenticated channels negotiated out-of-band using instance public keys.
3. **Server-Assisted WebSocket Relay (`server/routes/wsCluster.js`):** When direct NAT traversal fails, instances communicate via mutual WebSocket connections using `peer-relay` routing tagged with tenant filters.

---

## 5. CRDT Cross-Domain Merge & Conflict Resolution

### 5.1 Namespaced Operations
Operations across deployments never collide:
$$\text{OpID} = \text{instance} : \text{actor} : \text{counter}$$

### 5.2 Deterministic Safety Lattice
In disaster response, conflict resolution cannot blindly trust wall-clock timestamps from uncalibrated peer clocks. HelPhone applies a domain-aware safety lattice:

```
               [ critical (55) ]
                       |
               [ escalated (50) ]
                       |
               [ resolved (40) ]
                       |
              [ in_progress (30) ]
                       |
                [ assigned (20) ]
                       |
                 [ open (10) ]
                       |
                [ cancelled (5) ]
```

#### Merge Table
| Local State | Incoming Peer State | Winner State | Winner Annotation | Rationale |
|---|---|---|---|---|
| `resolved` | `escalated` | `escalated` | `lattice:status_escalated_over_resolved` | Life-safety: an ongoing emergency takes precedence over a premature resolution. |
| `open` | `assigned` | `assigned` | `lattice:status_assigned_over_open` | Forward lifecycle progression. |
| `in_progress` | `in_progress` | LWW (timestamp) | `lww:timestamp` | Concurrent updates converge via total ordering. |
| `critical` priority | `medium` priority | `critical` | `lattice:priority_critical_over_medium` | Maximum severity wins to ensure appropriate resource dispatch. |

---

## 6. Settlement & Mutual-Aid Accounting

Cross-border responder aid requires transparent reimbursement accounting:
1. **Cross-Instance IOU Issuance:** Upon responder acknowledgement of a federated dispatch, the recipient instance issues a `CrossInstanceIou`:
   $$\text{IOU} = \langle \text{iouId}, \text{debtor}, \text{creditor}, \text{incidentId}, \text{stroops}, \text{status: 'issued'} \rangle$$
2. **Periodic Bilateral Netting:** Periodically, paired HelPhone instances net their mutual IOUs:
   $$\Delta_{\text{Net}} = \sum \text{IOU}_{A \to B} - \sum \text{IOU}_{B \to A}$$
   The net balance is settled via a single paired `helphone_dao` proposal on Soroban, eliminating N individual micro-transactions.
3. **Default Escalation:** If a peer fails to net obligations within the agreed SLA, the unpaid IOU automatically escalates to a `helphone_dao` proposal vote for treasury intervention or formal mutual-aid write-off.

---

## 7. UI Demarcation & Custody Markers

To prevent operator confusion between locally verified ledger truth and foreign claims:
- Every event ingested from a peer instance is tagged with `custodyMarker: "peer_asserted"`.
- `ProvenanceBadge.jsx` renders foreign incidents in distinctive purple (`#7357FF`) with the copy:  
  `[⇄] Asserted by peer [Instance B] (not in local DAO custody)`.
- If an envelope was tampered with or failed signature checks, `ProvenanceBadge.jsx` renders an alert in coral (`#FF7A6B`):  
  `[⚠] Tamper detected / unverified peer assertion`.
- The PWA layer (`src/service-worker.js`) partitions foreign incident cache with a strict 24-hour expiration.

---

## 8. Adversarial Drills & Test Verifications

The federation test suite (`test/federation-protocol-spike.test.js`) verifies all 10 acceptance criteria with 56+ assertions:
1. **Round-Trip Dispatch:** A creates -> Federated Dispatch to B -> B Acknowledges -> A observes acknowledgement.
2. **Trust Bundle Rotation:** Instance A increments rotation counter; Instance B accepts new root and rejects superseded envelopes.
3. **Revocation Propagation:** Rogue responder revoked on A is rejected on B with logged timestamp evidence.
4. **CRDT Convergence:** 20+ concurrent-edit fixture pairs converge byte-identical under arbitrary delta orderings.
5. **Tamper Rejection:** Payload alteration, replayed nonce, stale bundle, and revoked responder all fail loudly with zero silent accepts.
6. **Partition Healing:** Reconnected peers merge offline divergent edits with deterministic winner annotations.
7. **Settlement Netting & Default Escalation:** Mutual IOUs net accurately; unpaid IOUs generate valid DAO proposals.
8. **OpenAPI Conformance:** `swagger.json` contains complete 3.0.3 definitions for all federation routes.
