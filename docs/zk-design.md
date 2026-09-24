# ZK Design — HelPhone

## Overview

Privacy-first proximity proofs on Stellar (Soroban). Users prove they are nearby, human, or reputable **without revealing** their identity, exact location, or personal data.

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Browser    │────▶│   Prover     │────▶│   Soroban    │
│  (circom +   │     │   (WASM)     │     │   Verifier   │
│   snarkjs)   │     │              │     │   Contract   │
└──────────────┘     └──────────────┘     └──────────────┘
       │                                        │
       │  private inputs: lat, lng              │  stores: nullifier hash
       │  public inputs: ref_point, radius      │  emits: ProofVerified
       │                                        │
       ▼                                        ▼
  Profile panel UI                      Status badges
  ("generate proof")                    ("active/inactive")
```

## Proof Types

### 1. Proof of Location (PoL)

**Goal**: Prove `distance(user, reference) ≤ radius` without revealing `user`.

**Circuit** (`pol.circom`):

- **Private inputs**: `user_lat`, `user_lng` (fixed-point, scaled to integers)
- **Public inputs**: `ref_lat`, `ref_lng`, `max_radius_meters`, `nullifier`
- **Constraint**: `haversine(user, ref) ≤ radius` — approximated via squared Euclidean in projected space for circuit efficiency, or a minimax polynomial for haversine.
- **Output**: Groth16 proof + public signals

**Contract** (`PolVerifier.sol` → `src/contracts/pol.rs`):

```
fn verify_proof(
    env: Env,
    proof: BytesN<192>,
    public_inputs: Vec<u128>,
    nullifier: BytesN<32>,
) -> bool
```

- Stores `nullifier` to prevent replay
- Emits `ProofVerified { nullifier, ref_lat, ref_lng, radius, timestamp }`
- Gas: ~50k (Groth16 verification in WASM)

**Client integration**:

- `snarkjs` runs `pol.wasm` in a Web Worker (non-blocking)
- User clicks "Generate Proof of Location" in profile panel
- Prover takes current `navigator.geolocation` as private input
- Public ref point comes from the help request they're responding to
- Proof sent via `wallet.signTransaction()` + `SorobanClient.sendTransaction()`

### 2. Proof of Humanity (PoH)

**Goal**: Prove the account is controlled by a human without KYC.

**Approach**: Semaphore-like identity commitment.

- User generates a random secret → computes `identity_commitment = poseidon(secret)`
- Contract stores commitment on first interaction
- To prove humanity: generate a Semaphore proof of membership in the "known humans" group
- Alternative (simpler): **Gitcoin Passport** integration — user proves they have >1 stamp (GovID, ENS, etc.) without revealing which ones, via a ZK proof over the passport data.

### 3. Proof of Reputation (PoR)

**Goal**: Prove "I have completed N help requests" without revealing which ones.

**Approach**: Accumulator-based.

- Each completed help request adds a `nullifier` to a Merkle tree in the contract
- User proves: "I know a secret that opens a leaf in the tree with N≥X completed requests"
- Uses the same nullifier from PoL to link proofs without linking identity

## Circuit Implementation

```
circuits/
├── pol.circom          # Proof of Location
├── poh.circom          # Proof of Humanity (Semaphore-ish)
├── por.circom          # Proof of Reputation (Merkle proof)
├── utils/
│   ├── fixed_point.circom  # Integer scaling for lat/lng
│   └── distance.circom     # Approx distance check
├── compile.sh          # circom + snarkjs pipeline
└── keys/
    ├── pol.zkey        # Proving key
    └── pol.vkey        # Verification key
```

### Distance Approximation

Haversine in a circuit is expensive (trig functions). Alternative:

1. Convert lat/lng to Web Mercator projected coordinates (EPSG:3857)
2. Use squared Euclidean distance in projected space
3. Apply a correction factor for the latitude band

This gives ~10% error at worst, which is acceptable for "nearby" (radius ≥ 100m). For higher precision, use a minimax polynomial approximation of haversine with 8 terms (~0.5% error, ~8000 constraints).

## Contract Architecture (Soroban)

```
src/
├── contracts/
│   ├── pol.rs          # Proof of Location verifier
│   ├── poh.rs          # Proof of Humanity registry
│   └── por.rs          # Proof of Reputation accumulator
├── types.rs            # Shared types (Proof, Nullifier, etc.)
├── events.rs           # Event definitions
└── test/
    ├── pol_test.rs
    ├── poh_test.rs
    └── por_test.rs
```

### Contract: pol.rs

```rust
pub trait PolContract {
    fn init(env: Env, vk: BytesN<64>);
    fn verify(env: Env, proof: BytesN<192>, public_inputs: Vec<u128>, nullifier: BytesN<32>) -> bool;
    fn is_nullifier_used(env: Env, nullifier: BytesN<32>) -> bool;
}
```

- `init`: stores the Groth16 verification key (uploaded by contract admin)
- `verify`: runs WASM Groth16 verifier, checks nullifier not used, stores it
- `is_nullifier_used`: queries nullifier set (view function, no fee)

### Stellar Asset Integration

All interactions paid in XLM (network fee). No custom token needed.

Users submit proofs via `SorobanClient.sendTransaction()` with a small XLM fee.

## UI Integration

### Profile Panel — ZK Proofs Section (already built)

Each proof type shows:

- **Inactive** (grey dot) → user hasn't generated this proof yet
- **Active** (green dot) → proof exists and is valid
- **Generating** (spinner) → WASM prover is running
- **SOON** → not implemented yet

### Flow: Proof of Location

1. User clicks "Offer Help" mode
2. Selects a request on the map
3. Instead of revealing their exact location, they click "Generate Proof of Location"
4. Browser runs `pol.wasm` in a Web Worker (private inputs: GPS; public: request's location + 500m radius)
5. Proof is submitted to the Soroban contract
6. If valid, the responder's dot turns green on the requester's map (without showing exact responder position)
7. Requester sees: "Someone is nearby (proven)" instead of exact coordinates

## Security Considerations

- **Nullifiers**: prevent replay attacks. Each proof can only be used once.
- **Front-running**: proofs include a timestamp public input; contract checks freshness (±5 min window).
- **Prover privacy**: WASM runs locally; private inputs never leave the browser.
- **DoS**: proof verification has a fixed gas cost; nullifier set prevents duplicate submissions.

## WASM Linear Memory Pool (`src/lib/wasmMemory.ts`)

Proving is memory-heavy: Barretenberg allocates CRS + witness buffers in WASM linear memory. Repeated `generateProof()` calls without recycling cause page thrashing and browser OOM.

### Pool

- Pre-allocated `ArrayBuffer` buckets: 4KB, 16KB, 64KB (1 page), 256KB, 1MB, 4MB, 16MB — all WASM-page-aligned.
- `allocate(size)` rounds up to bucket; reuses idle buffers before `new ArrayBuffer`.
- `release(buf)` zero-fills and returns to pool for next run (prevents witness leakage).
- `MAX_MEMORY_BYTES = 512MB` (8192 WASM pages) — hard cap to avoid tab crashes. `allocate` throws if `totalAllocated + bucket > 512MB`.
- `preallocate()` warms 2×64KB + 2×1MB + 1×4MB so first proof doesn't jank.

### Usage

```ts
import { getWasmMemoryPool } from './src/lib/wasmMemory.js';

// In src/lib/zk.js — wraps witness + proof generation
const mem = getWasmMemoryPool();
const w = mem.allocate(256 * 1024);
const p = mem.allocate(4 * 1024 * 1024);
try {
  const { witness } = await noir.execute(inputs);
  const { proof } = await backend.generateProof(witness);
} finally {
  mem.release(w); mem.release(p);
}

// In src/workers/zk-worker.js — same pool inside Worker
```

### Worker

`src/workers/zk-worker.js` runs Noir + Barretenberg off-main-thread and uses an in-worker `WorkerMemoryPool` shim with identical 512MB cap. Main thread talks to it via:

```js
worker.postMessage({ type: 'prove', id, inputs });
worker.onmessage = ({ data }) => {
  if (data.type === 'done') handleProof(data.proof);
};
```

### Vite

`vite.config.js` excludes `@noir-lang/*` and `@aztec/bb.js` from `optimizeDeps` and sets `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` so the prover can use `SharedArrayBuffer` / threads when available. See `vite.config.ts` for the `worker.format: 'es'` and `wasmMemory` chunk.

### Stats & Monitoring

```ts
pool.getStats(); // { totalAllocated, poolSize, pooledBuffers, activeBuffers, peakAllocated, recyclingRate, utilisationPct }
pool.getPageCount(); // allocated pages
```

Tests: `test/wasm-memory.test.js` verifies recycling, cap enforcement, zero-fill, and sequential-run reuse.

## Roadmap

| Phase | What                                     | Depends On |
| ----- | ---------------------------------------- | ---------- |
| 1     | Design + circuit prototyping             | —          |
| 2     | `pol.circom` + trusted setup             | Phase 1    |
| 3     | Soroban `pol.rs` verifier                | Phase 2    |
| 4     | Client WASM integration (snarkjs worker) | Phase 3    |
| 5     | Proof of Humanity circuit                | Phase 4    |
| 6     | Proof of Reputation accumulator          | Phase 5    |
| 7     | Production audit                         | Phase 6    |
| 8     | **WASM memory pooling** (this doc)       | Phase 4    |

## Next Step

Start with Phase 1: build the `pol.circom` circuit with the approximate distance check. Needed:

1. Define the fixed-point scaling (e.g., lat/lng × 10^6 → integer)
2. Define the exact distance formula to use
3. Decide whether to run a local trusted setup or use a ceremony

## Binary Reproducibility (#590)

- The committed artifact `circuits/target/aegis.json` is pinned by SHA-256 in
  `circuits/target/aegis.sha256`. CI (`bash scripts/verify-wasm-build.sh`)
  fails on any mismatch, blocking untrusted pre-compiled blobs.
- Deterministic flags: `circuits/Nargo.toml` pins `compiler_version`; Soroban
  manifests use the locked release profile (`opt-level = "z"`, `lto = true`,
  `codegen-units = 1`); npm builds install with `npm ci`.
- After a deliberate, reviewed rebuild: `bash scripts/verify-wasm-build.sh --update`.
- `src/lib/zk.ts` loads only this verified artifact (see header comment).
