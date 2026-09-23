# ADR-005: Client-Side ZK Proof Aggregation Feasibility & Resource Allocation Limits

- **Status:** Proposed (spike #605 complete)
- **Date:** 2026-09-23
- **Evidence:** [Spike report](../spikes/605-zk-circuit-complexity-benchmark.md) · [raw results](../spikes/results/zk-aggregation.json) · `scripts/spikes/zk_aggregation_benchmark.js`
- **Prototype:** `circuits/responder_credential/`, `circuits/recursive_verifier/`, `src/utils/zkProver.js`

## Context

Responders prove their certifications with Noir ZK proofs. The spike asked whether a mobile web view could fold **5 responder proofs into one recursive proof**, and whether client-side verification could get under 500 ms.

Toolchain: nargo 1.0.0-beta.9 with bb.js 0.87.9 (UltraHonk), proving in WASM on the measurement laptop (i5-4300U, 4 threads).

## What was measured

| | Gates (dyadic) | Prove (4 threads) | Peak memory | Verify, VK cached |
|---|---|---|---|---|
| Inner `responder_credential` | 3,738 (2^12) | 0.6–2.3 s | — | **~40 ms** each |
| 5 inner proofs verified one by one | — | — | — | **214 ms** in total |
| Aggregator, N=1 (wraps 1 proof) | 664,993 (2^20) | **99 s** | **2.6 GB** | 39 ms |
| Aggregator, N=2 | 1,389,265 (2^21) | **out of memory** | 4.0 GB, then trap | — |
| Aggregator, N=5 | 3,562,082 (2^22) | **out of memory** | above the 4 GiB WASM limit | — |

Each in-circuit UltraHonk verification costs about **710k gates**. The aggregated proof is the same size as one inner proof: 14,592 bytes (456 fields).

## Decision

1. **Do not aggregate proofs on the client.** Folding even 2 proofs exceeds bb.js's 4 GiB WASM32 memory limit. Folding 1 takes 2.6 GB and about 100 s on a laptop. That is above the iOS Safari cap (1 GiB) and far above the tab budget of a budget Android phone. N=5 is 5× beyond what fits.
2. **Client-side verification needs no aggregation.** Verifying the 5 inner proofs individually took 214 ms in total, under the 500 ms target, provided the verification keys are **shipped with the app** rather than recomputed. bb.js's `verifyProof()` regenerates the VK on every call; for the outer circuit that took 26 s. `zkProver.verifyInner/verifyOuter` cache the VK.
3. **Aggregate where there is native memory**, if on-chain cost requires it: a relay or coordinator running native `bb` (64-bit, multi-threaded) folds the responder proofs and submits one proof. The aggregated proof is exactly one proof's size, so on-chain verification cost drops roughly N× (see the report for the model). Responders keep proving their own small inner proof on-device (0.6–2.3 s).
4. **Keep the prototype circuits** as the reference design. The aggregator binds the inner VK by hash, forces all proofs onto one incident, epoch and minimum level, and rejects duplicate nullifiers. Use it when server-side aggregation is built.

## Consequences

- **Positive:** Responder devices only generate a tiny proof (a 2^12 circuit). Verification on the client is well within budget.
- **Negative:** Aggregation needs a trusted-for-liveness (not for soundness) aggregator node. Off-grid, that means the commander device or a relay with more memory than a phone. It will not run in a browser tab until bb ships wasm64 / Memory64 support.
- **Toolchain issues found (fixed or worked around):**
  - **bb.js 0.87 bug.** `generateRecursiveProofArtifacts()` passes the VK to `acirVkAsFieldsUltraHonk` without `RawBuffer`, adding a second length prefix. Every VK field ends up shifted by 4 bytes, and in-circuit verification fails with `Builder failure when we have real witnesses` / `null function or function signature mismatch`. `zkProver.innerVk()` derives the fields the way `generateProof()` does. This should be reported upstream.
  - `std::hash::poseidon2::Poseidon2` is not public in Noir 1.0.0-beta.9, so the aggregator implements its own Poseidon2 sponge, mirrored on the host (`hashVkFields`).
  - nargo 1.0.0-beta.9 cannot build packages nested under `circuits/Nargo.toml`, the existing `aegis` package. `circuits/recursive_verifier/build.sh` stages both packages in a temp directory.
- **Not measured:** On-chain verification cost on Soroban and on EVM. The Soroban `noir_verifier` contract is not in this repository, and no EVM toolchain was available. The report gives a clearly labelled cost model and the steps to measure it.
