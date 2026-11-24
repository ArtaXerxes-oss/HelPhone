# ADR-018 — Centerless Federation Protocol: Gossip Topology & Conflict-Resolution Model

**Date:** 2026-10-16
**Status:** Proposed
**ISP / Spike:** ISP-144
**Decision owner:** @helphone-dispatch-owner
**Review required:** @helphone-maintainers, @helphone-dispatch-owner, @helphone-pwa-owner

---

## Context

A single HelPhone deployment serves one geographic zone. When city A and city B
each run their own deployment, a responder registered in city A cannot see a
request raised in city B's overlap zone. Three real scenarios make this urgent:

1. Cross-border disaster zones (flood that spans two municipal boundaries).
2. Regional NGO deployments that want shared responder pools without shared
   databases (tenant isolation per ADR-017).
3. Offline-mesh scenarios where two disconnected nodes re-merge after a
   connectivity gap (ADR-004 CRDT merge logic applies).

`src/lib/crdt.ts` and `src/services/crdtSync.js` implement a CRDT for local
state convergence. `server/routes/wsCluster.js` and `server/lib/redisPubSub.js`
implement single-node pub/sub. `src/workers/routingWorker.js` does offline
routing within a single map tile set.

The forcing function is ISP-144: design the federation protocol before
multi-tenant deployments diverge into incompatible data models.

---

## Options considered

### Option A — Hub-and-spoke federation (central relay node)

All regional nodes connect to a central HelPhone relay. Cross-region requests
are routed through the relay. The relay is operated by the HelPhone DAO.

**Evidence:** `server/routes/wsCluster.js` already supports horizontal scaling
via Redis. A relay could be the same server type.

**Pros:**
- Simplest topology; no gossip protocol to implement.
- Single point of conflict resolution.

**Cons:**
- Central relay is a single point of failure — catastrophic during a disaster
  that takes down internet infrastructure in the relay's region.
- DAO-operated relay creates trust and governance dependencies that conflict
  with municipal operator autonomy.
- Violates the ISP-144 "centerless" requirement.

---

### Option B — Gossip protocol with CRDT merge (epidemic broadcast)

Each node maintains a peer list. New requests and state updates are gossiped
to k random peers (k=3 initially). CRDTs in `src/lib/crdt.ts` ensure that
receiving the same update multiple times is idempotent. Conflict resolution
uses last-write-wins on `ledger_seq` for mutable fields (request status)
and append-only sets for immutable fields (offers, audit log).

**Evidence:** `docs/spikes/604-crdt-memory-analysis.md` benchmarks the CRDT
merge overhead at ~1.4 ms per 1,000-entry state vector on a mid-range device.
`src/services/crdtSync.js` already implements the CRDT sync loop for local
(single-node) merges. ADR-004 accepted state-vector pruning for the local
case; gossip extends this to the inter-node case.

**Pros:**
- No central dependency; survives relay failure.
- CRDT merge is already implemented; gossip is additive.
- Aligns with PWA offline-merge path (ADR-004).

**Cons:**
- Gossip convergence latency is probabilistic; worst-case O(log N × gossip interval).
  For N=100 nodes and a 500 ms gossip interval, worst-case convergence is ~4.5 s.
  Acceptable for non-emergency state sync; must be characterised for emergency
  request propagation separately.
- Peer discovery is unsolved; requires a bootstrap mechanism (DNS seed or
  on-chain peer list in `helphone_dao`).
- Anti-entropy (reconciling nodes that were partitioned) requires a vector-clock
  comparison pass, not just gossip.

**Cost / effort:** ~5 days (gossip layer ~2d, peer discovery ~1d, anti-entropy ~1d, tests ~1d).

---

### Option C — Stellar network as the federation bus

All nodes publish and subscribe to events on the Stellar network (Soroban
events, `server/indexer/daemon.ts`). Cross-region state is on-chain by
definition; nodes index the chain independently.

**Pros:**
- No peer discovery problem; the chain is the shared state.
- Audit trail is immutable.

**Cons:**
- Stellar testnet median ledger close is ~6 s; unacceptable for real-time
  dispatch (compare to `server/routes/dispatch.ts` WebSocket latency < 100 ms).
- On-chain storage cost (see ADR-001) scales with federation breadth; untenable.
- Offline nodes cannot submit or read while disconnected.

---

## Decision

**Chosen:** Option B — Gossip protocol, **deferred to ISP-144 Phase 2.**

**Phase 1 (ISP-144 deliverable):** Define the federation data model
(peer identity, message envelope, CRDT vector-clock schema) and the bootstrap
mechanism (DAO-maintained on-chain peer seed list in `helphone_dao`). No
gossip implementation; Phase 1 is spec only.

**Phase 2:** Implement gossip in `server/routes/wsCluster.js` and the
anti-entropy reconciliation pass. Wire into `src/services/crdtSync.js`.

**Deferral rationale:** Phase 1 outputs are required before ADR-017's tenant
model is finalised (tenant identity must be the federation node identity).
Full implementation depends on the ZK attestation in ADR-016 (a federated
responder's credential proof must be verifiable at any node). Both ADRs
are in progress; proceeding with Phase 1 spec now avoids blocking model drift.

**Expiry:** This ADR's Deferred status expires 2027-Q1. If Phase 2 has not
started by that date, the decision owner must re-evaluate or escalate.

---

## Consequences

### Subsystems affected

| Subsystem | Impact | Follow-up action | Owner | Due |
|---|---|---|---|---|
| `src/lib/crdt.ts` | Extend vector-clock schema for inter-node identity | Spec + implementation | @helphone-pwa-owner | 2026-Q4 (spec) |
| `contracts/helphone_dao` | Add peer seed list storage key | Rust implementation | @helphone-contract-owner | 2026-Q4 |
| `server/routes/wsCluster.js` | Phase 2: gossip fan-out | Phase 2 implementation | @helphone-dispatch-owner | 2027-Q1 |
| `docs/adr/ADR-017` | Tenant model must align with federation node identity | Cross-ADR constraint | @helphone-db-owner | 2026-Q4 |

### Risks

- **Gossip storm:** Without rate limiting, a high-churn event (disaster surge)
  could cause O(N²) message amplification. Rate-limit design is a Phase 2
  requirement.
- **Byzantine peers:** A malicious federated node could gossip false data.
  Mitigation: all federated messages must carry a Soroban transaction hash as
  proof of on-chain anchor; unsigned gossip is rejected.

### Follow-up ADRs

- ADR-016: Attestation must be verifiable at any federation node.
- ADR-019: Jurisdiction-triggered isolation must work per-node in a federated
  topology.

---

## Done-definition checklist

- [x] Status set
- [x] Context names the forcing function
- [x] ≥2 options considered with trade-offs
- [x] Decision cites evidence
- [x] Consequences table filled
- [x] Added to `docs/adr/README.md` index
- [ ] CODEOWNERS review obtained
