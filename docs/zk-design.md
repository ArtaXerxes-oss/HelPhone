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

## Barretenberg browser feasibility decision (#577)

The browser path is allowed only when all three measured gates pass:

- compiled Noir circuit: at most **50,000 constraints**;
- warm proof generation: at most **3,000 ms** on the target low-power profile;
- incremental JS/WASM heap growth: at most **256 MiB**.

`circuits/scripts/benchmark.sh` now fails above the constraint ceiling and reports
whether measured proving latency selects browser execution or server offload. The
worker returns `profiling.provingMs`, `profiling.heapDeltaBytes`, and pool stats
with each proof; `assessBrowserProvingFeasibility` makes the routing decision.

The location circuit keeps four native `u64` bounding-box comparisons and one
Poseidon2 nullifier, avoiding trigonometric, square-root, and general distance
gadgets. The humanity prototype removed a redundant pseudo-Y equation that added
field operations without implementing real curve verification. Humanity proofs
must not ship until that placeholder is replaced by a reviewed signature gadget.

This environment does not include `nargo`, so no new numeric benchmark result is
claimed here. Run `bash circuits/scripts/benchmark.sh 5` on the low-power target,
then retain browser proving only if every gate above passes; otherwise use the
existing server prover path.

## Differential-privacy zone checks (#529)

`contracts/aegis_vault/src/privacy.rs` enforces a differential-privacy policy on the public bounding box of every funded zone.

### What can and cannot be verified on-chain

A claimant's coordinates are private witnesses. The chain never sees them, so it cannot verify that noise was added to them, and nothing here claims to. What it *can* enforce, using only the box already committed as public inputs, is that the region a proof is allowed to reveal is no finer than the noise bound it is supposed to hide behind. These are policy checks on public data, not a proof that noise was added.

### The rules (`fund_zone`, before any token moves)

| Check | Rule | Error |
| --- | --- | --- |
| Laplace bound | Each side >= `sensitivity / epsilon * t`, rounded up to the grid | `BoxTooSmall` (16) |
| Grid alignment | All four edges are multiples of `grid` | `BoxNotOnGrid` (15) |
| Well-formed | `min < max` on both axes, within `0..=3.6e9` / `0..=1.8e9`, every word fits a `u64` | `BoxMalformed` (14) |
| Overlap guard (k-anonymity) | Two zones are disjoint, or intersect in at least the Laplace bound per axis **and** `k_cells` grid cells | `ZoneOverlapTooSmall` (17) |
| Parameters | `epsilon`, `sensitivity`, `t`, `grid`, `k` all non-zero and the minimum box fits the map | `InvalidPrivacyParams` (13) |

Laplace noise with scale `b = sensitivity / epsilon` stays within `b * t` of the true value with probability `1 - e^-t` (`t = 3` is about 95%). A box narrower than that cannot contain a location fuzzed at that epsilon. Smaller epsilon means more noise and a larger minimum box. Integer arithmetic throughout; the scale rounds up, never down.

**Boxes are closed.** The circuit accepts `x <= box_x_max`, so a claimant on a shared edge is inside both neighbours. Two zones that merely touch therefore intersect in a zero-width line, the worst case for anonymity, and are rejected like any other too-small overlap.

### Configuration

Off by default: nothing changes for existing deployments until an admin calls `set_privacy_params`. Defaults once enabled: `epsilon = 1.0`, `sensitivity = 100_000` (0.01 deg, about 1.1 km), `t = 3`, `grid = 10_000` (about 110 m), `k_cells = 25`, giving a 300_000-unit (0.03 deg) minimum side.

| Function | Purpose |
| --- | --- |
| `set_privacy_params(admin, params)` | Admin only; rejects nonsense parameters |
| `privacy_params()` | Current parameters |
| `min_box_dimension()` | Smallest allowed side under them |
| `validate_zone(prefix)` | Dry run: applies every check, registers nothing |

Tightening the parameters never strands funds: the checks run only when a zone is funded, so a zone funded earlier stays claimable.

### Limits worth knowing

- The overlap guard compares against the newest **128** funded zones (`MAX_TRACKED_ZONES`), which keeps the scan bounded. A zone that has aged out of that window is no longer checked against.
- It constrains the *shape and overlap of public zones*. It does not stop a claimant from being identified by other means, and it does not bound how many claims a zone receives.
- Enforcement is at funding time. A campaign funded again with the same id is not treated as overlapping itself.

### Client (`src/lib/privacy.ts`)

Mirrors the rules with the contract's `u64` semantics (BigInt), so a UI can preflight instead of finding out from a failed transaction: `validateZone`, `checkOverlap`, `minBoxDimension`, `alignZone` (snaps edges outward to the grid, then widens symmetrically to the bound, shifting rather than shrinking at the map edge; it never makes a region finer) and `buildPrivateLocationProofZone`. `getZonePrivacyPolicy()` in `src/lib/contract.ts` reads the live parameters. The Rust and JS tests share test vectors so they cannot drift.

### Follow-up: circuit floor (not in this change)

The issue also proposes noise-threshold assertions in `circuits/src/main.nr`. That is deliberately **not** included: `circuits/target/aegis.json` is a pinned build artifact (`aegis.sha256`, checked by `scripts/verify-wasm-build.sh`), and changing the circuit requires rebuilding it with `nargo` (1.0.0-beta.9), regenerating the verification key with `bb`, redeploying the verifier and re-recording the hash, none of which could be done or verified here. The contract check above enforces the same property meanwhile. If wanted, the circuit would add a fixed floor below the contract's default, after the existing geofence asserts (no new public inputs, so the 224-byte layout is unchanged):

```noir
global MIN_BOX_DIM: u64 = 30_000; // below the contract default of 300_000
assert(box_x_max - box_x_min >= MIN_BOX_DIM, "Zone too narrow (longitude)");
assert(box_y_max - box_y_min >= MIN_BOX_DIM, "Zone too narrow (latitude)");
```
