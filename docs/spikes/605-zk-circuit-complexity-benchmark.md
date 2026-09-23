# Spike #605: Noir Circuit Complexity Analysis & Proving Time vs Memory Matrix

Feeds [ADR-005](../adr/ADR-005-zk-proof-aggregation.md). Raw numbers: [`results/zk-aggregation.json`](results/zk-aggregation.json).

## What was built

| File | Purpose |
|---|---|
| `circuits/responder_credential/src/main.nr` | Inner circuit. A responder proves they hold an authority-issued credential (a Poseidon2 commitment), at or above the required level and not expired, and outputs a per-incident nullifier. 4 Noir tests. |
| `circuits/recursive_verifier/src/main.nr` | Aggregator. Verifies N UltraHonk proofs in-circuit with `std::verify_proof_with_type`, pins the inner VK by a Poseidon2 hash (a public input), forces a shared incident, epoch and minimum level, and rejects duplicate nullifiers. N is a compile-time global. 1 Noir test. |
| `circuits/recursive_verifier/build.sh` | Builds both packages in a staging directory (see the nargo limitation below). Produces `target/recursive_verifier{,_n1,_n2}.json`. |
| `src/utils/zkProver.js` | Host side: proof ↔ field conversion, the VK sponge hash mirroring the circuit, input assembly with the same checks as the circuit (fail before proving), device extrapolation, and a lazily loaded prover with cached-VK verification |
| `scripts/spikes/zk_aggregation_benchmark.js` | This benchmark. Each outer proof runs in a fresh child process, so peak RSS is isolated; WASM memory never shrinks. |
| `test/zk-aggregation.test.js` | 11 unit tests of the host-side logic |

## Circuit complexity

| Circuit | ACIR opcodes | Backend gates | Dyadic size |
|---|---|---|---|
| `responder_credential` | 17 | 3,738 | 2^12 |
| `recursive_verifier`, N=1 | 150 | 664,993 | 2^20 |
| `recursive_verifier`, N=2 | 153 | 1,389,265 | 2^21 |
| `recursive_verifier`, N=5 | 174 | 3,562,082 | 2^22 |

The ACIR opcode count barely moves with N, because each recursive verification is a single black-box call. In the backend, each call expands to **about 710k gates**, roughly 190× the circuit it verifies. The VK hash, the shared-input constraints and the nullifier checks add under 1 %.

## Proving time vs memory

Measured on an i5-4300U (2 cores / 4 threads, 2014), bb.js 0.87.9 WASM, Node 22.

| Proof | Threads | Prove | Peak RSS | Result |
|---|---|---|---|---|
| inner × 5 | 4 | 2.3 s (cold), then 0.61–0.76 s | — | ✔ |
| outer N=1 | 4 | **99.1 s** | **2,597 MB** | ✔ verified |
| outer N=2 | 4 | — | 4,026 MB | ✘ `unreachable` trap: out of memory at the 4 GiB WASM32 limit |
| outer N=5 | 4 | — | — | not completed (stopped); 2^22 is 2× the N=2 circuit, which already ran out of memory |

The benchmark script also covers a single-threaded N=1 run, N=1 under the iOS 1 GiB cap, and the keccak/EVM flavour with the Solidity verifier. **These were not run in this time box.** The run was stopped after the N=5 job started, and the JSON was transcribed from its log. N=1 already uses 2.6 GB, so it cannot fit under a 1 GiB cap. An earlier run of the same N=1 job measured 93.1 s and 2,625 MB, which is consistent.

### Extrapolation to devices (assumptions, not measurements)

| Device class | WASM ceiling | Realistic tab budget | Aggregate N=1? | Aggregate N=5? |
|---|---|---|---|---|
| High-end desktop | 4 GiB | about 4 GB | yes, but memory-heavy | **no** (above the 4 GiB WASM32 limit) |
| Mid-range Android, 4 GB RAM | 4 GiB | about 1.5 GB | no | no |
| Budget Android, 2–3 GB RAM | 4 GiB | about 0.8 GB | no | no |
| iPhone Safari | **1 GiB** (bb.js caps it) | 1 GiB | no | no |

## Verification latency (target: under 500 ms on the client)

| What | Time |
|---|---|
| Verify one inner proof, VK cached | 39–51 ms |
| **Verify all 5 inner proofs** | **214 ms** |
| Verify the aggregated proof (N=1), VK cached | 39 ms warm, 57 ms first |
| Regenerate the inner VK (what `backend.verifyProof()` does on every call) | 157 ms |
| Regenerate the **outer** VK | **25.8 s** |

The 500 ms target is met **without** aggregation, as long as verifiers ship precomputed VKs. Aggregation would bring 5 verifications (214 ms) down to one (about 40 ms), but only at the proving costs above.

## On-chain verification cost: model, not measured

Neither chain could be measured in this spike:

- The Soroban `noir_verifier` contract (`ultrahonk_rust_verifier`) is deployed from outside this repository.
- No EVM toolchain (solc, anvil or foundry) was available.
- Native `bb` 0.87 crashes on this CPU with an illegal instruction.

What *is* measured is that an aggregated proof is **the same size as one inner proof** (14,592 bytes, 456 fields). Public inputs are 2N+4 fields instead of 5 per proof. Verifier work in UltraHonk is dominated by one pairing check plus commitment MSMs of fixed size, independent of the circuit verified. So:

- **Verifying 1 aggregated proof costs about the same as verifying 1 inner proof.** Submitting 5 proofs separately costs about 5×. The saving is about (N−1)/N, which is 80 % for N=5, minus a small increase in public-input calldata.
- **EVM (for sizing only, from EIP-196/197/2028 prices):**
  - Calldata for 14.6 KB costs up to about 235k gas at 16 gas per non-zero byte.
  - The pairing precompile with 2 pairs costs 113k gas.
  - MSM ecMul costs 6,000 gas per point.

  The sumcheck arithmetic on top of these is **not** estimated. Measure it with bb.js `UltraHonkBackend.getSolidityVerifier()` and `forge test --gas-report`.
- **Soroban:** measure with `soroban-sdk`'s `env.cost_estimate().budget()` in a unit test that registers `noir_verifier` with the outer VK. Compare it against the per-transaction instruction limit.

## Toolchain findings

1. **bb.js 0.87 `generateRecursiveProofArtifacts()` returns misaligned VK fields.** It passes a plain `Uint8Array` to `acirVkAsFieldsUltraHonk`, and serialization adds a second length prefix. Field 0 comes out as `0x6e4 << 32` (0x6e4 is the 1,764-byte VK length) instead of the circuit size, and every in-circuit verification then fails deep in WASM (`Builder failure when we have real witnesses`, then `null function or function signature mismatch`). The same thing happens with 0.87.0. Workaround: `api.acirVkAsFieldsUltraHonk(new RawBuffer(vk))`, which is what bb.js's own `generateProof()` does.
2. **Proof layout.** The proof is 456 fields: 16 pairing-point fields plus 440 core fields, with public inputs held separately. The VK is 112 fields and records 5 + 16 = 21 public inputs.
3. `Poseidon2::hash` is private in Noir 1.0.0-beta.9's stdlib, so the circuit uses an explicit width-4, rate-3 sponge.
4. nargo 1.0.0-beta.9 resolves the outermost `Nargo.toml`, so packages under `circuits/` (the `aegis` package) fail with ``Selected package `aegis` was not found``. `build.sh` works around it.
5. The comments in Noir sources must be ASCII.
