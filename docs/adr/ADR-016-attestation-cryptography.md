# ADR-016 — Responder Attestation Cryptography: ZK Credential vs On-Chain Registry

**Date:** 2026-10-16
**Status:** Proposed
**ISP / Spike:** ISP-142
**Decision owner:** @helphone-zk-owner
**Review required:** @helphone-maintainers, @helphone-zk-owner, @helphone-security-owner

---

## Context

HelPhone's current model lets any wallet holder submit an offer to respond to
an emergency request. There is no attestation that a responder has relevant
credentials (first-aid certification, recognised community role, emergency
services affiliation). `contracts/aegis_vault/src/privacy.rs` includes an
`expert_verification` path, and `server/indexer/exporter.ts` indexes
`expert_verifications`, but the cryptographic link between an on-chain
responder identity and an off-chain credential is unspecified.

The forcing function is ISP-142: a responder who lies about having CPR
certification is a life-safety liability. The attestation mechanism must be:

- **Privacy-preserving:** the responder's real-world identity must not be
  required on-chain.
- **Verifiable:** the requester and the DAO must be able to confirm the
  credential is real without contacting the issuing authority per-request.
- **Revocable:** a revoked credential must propagate to the contract within one
  ledger close cycle (~6 s).

This decision interacts with `circuits/responder_credential/` (a Noir circuit
stub for credential proofs) and `src/lib/zk.ts` (the prover orchestration).

---

## Options considered

### Option A — On-Chain Registry (public credential hash list)

A trusted attester (e.g., Red Cross API, municipal emergency services) publishes
a Merkle root of valid credential hashes to a Soroban persistent storage entry
in `aegis_vault`. Responders prove membership by submitting their credential
hash. The contract checks inclusion.

**Evidence:** `contracts/aegis_vault/src/lib.rs` has storage key `REGISTRY_ROOT`.
The Merkle verification is ~50 instructions, within the CPU budget measured in ADR-001.

**Pros:**
- Simple contract logic; no ZK proving overhead on the responder device.
- Revocation is immediate: attester posts new root excluding revoked entries.

**Cons:**
- Credential hash alone is not privacy-preserving if the hash is deterministic
  and known to the attester (linkability attack).
- Requires the attester to be online and trusted; single point of failure.
- No credential-type differentiation (CPR vs hazmat vs mental-health first aid).

**Cost / effort:** ~1 day Rust + attester API integration (external dependency).

---

### Option B — ZK Credential Proof (Noir circuit in `circuits/responder_credential/`)

Responder's browser generates a Noir ZK proof that they hold a valid credential
signed by a trusted attester's Ed25519 key (already in `src/lib/crypto.ts`).
The proof reveals only the credential type and expiry epoch, not identity.
`aegis_vault` verifies the proof's public inputs on-chain.

**Evidence:** `circuits/responder_credential/src/` contains a Noir stub. The
existing `circuits/src/main.nr` location-proof circuit demonstrates that the
toolchain (`nargo`, `@aztec/bb.js`) is operational. Proving time for a similar
circuit measured at ~2.8 s on a mid-range mobile device (see
`docs/spikes/605-zk-circuit-complexity-benchmark.md`, Poseidon2 component).

**Pros:**
- Strong privacy: no linkability between on-chain proof and off-chain identity.
- Credential-type differentiation is a public input; smart contract can require
  `CPR_CERTIFIED` for medical emergencies.
- Revocation: attester rotates their signing key; old-key proofs fail
  verification against the new trusted-key list.

**Cons:**
- ~2.8 s proving latency is acceptable for registration but unacceptable for
  per-request proof generation. Must be cached in `src/services/zkProofCache.js`.
- Circuit maintenance requires ZK expertise (bus-factor risk documented in
  `docs/bus-factor-ledger.md`).
- Proving key rotation is operationally complex (see ADR-005 §consequences).

**Cost / effort:** ~4 days ZK circuit + 1 day contract + 0.5 day caching layer.

---

### Option C — WebAuthn Passkey + Off-Chain Attester Signature (hybrid)

Responder registers a Passkey (`src/lib/passkey.ts`). The attester issues an
ECDSA-over-P256 credential assertion tied to the Passkey's public key. The
server (`server/routes/passkey-auth.js`) verifies the assertion before writing
to `aegis_vault` via the server's contract key.

**Pros:**
- Reuses existing Passkey infrastructure; no new ZK circuit work.
- Revocation is server-side and immediate.

**Cons:**
- Centralises trust in the server: a compromised server can forge attestations.
- No on-chain verifiability; the contract trusts the server's word.
- Contradicts the privacy-preservation requirement (server sees identity).

---

## Decision

**Chosen:** Option B — ZK Credential Proof, with a phased rollout.

**Phase 1 (ISP-142 deliverable):** Complete `circuits/responder_credential/`
to prove Ed25519 credential validity and credential-type membership. Cache the
proof in `src/services/zkProofCache.js` keyed by `(credentialId, epoch)`.
Credential epoch advances monthly; cached proofs remain valid for one epoch.

**Phase 2 (follow-up):** Implement on-chain trusted-key rotation (attester key
list in `aegis_vault` persistent storage), allowing revocation within one epoch
without requiring a contract upgrade.

**Rationale:** Option A's linkability flaw is disqualifying for a life-safety
app. Option C re-centralises trust that the ZK architecture explicitly removes.
Option B's 2.8 s proving latency is acceptable when cached and only incurred at
registration / epoch renewal, not per-request.

---

## Consequences

### Subsystems affected

| Subsystem | Impact | Follow-up action | Owner | Due |
|---|---|---|---|---|
| `circuits/responder_credential/` | Complete Noir circuit for Ed25519 credential proof | ZK implementation | @helphone-zk-owner | 2026-Q4 |
| `contracts/aegis_vault/src/lib.rs` | Add `verify_credential_proof` entry point | Rust implementation | @helphone-contract-owner | 2026-Q4 |
| `src/services/zkProofCache.js` | Epoch-keyed credential proof caching | JS implementation | @helphone-zk-owner | 2026-Q4 |
| `src/lib/passkey.ts` | No change; passkey used for wallet auth only | — | — | — |
| Bus-factor ledger | ZK subsystem is bus-factor 1; graduation drill required | See `docs/bus-factor-ledger.md` | @helphone-maintainers | 2026-Q4 |

### Risks

- ZK bus-factor: if `@helphone-zk-owner` is unavailable, circuit maintenance
  stalls. Graduation drill (`aegis_vault` ZK rotation) must be completed by a
  backup before Phase 2 ships.
- Proving-key version drift: tracked in `scripts/verify-wasm-build.sh`. Any
  circuit change must regenerate the proving key and update the SHA-256 in
  `src/wasm/telemetry_reader.wasm.sha256` (pattern by analogy).

### Follow-up ADRs

- ADR-019: Compulsion-law halt doctrine — credential proof must be considered
  when designing the jurisdiction-triggered isolation path.

---

## Done-definition checklist

- [x] Status set
- [x] Context names the forcing function
- [x] ≥2 options considered with trade-offs
- [x] Decision cites evidence
- [x] Consequences table filled
- [x] Added to `docs/adr/README.md` index
- [ ] CODEOWNERS review obtained
