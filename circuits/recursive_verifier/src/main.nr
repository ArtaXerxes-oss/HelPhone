// recursive_verifier - spike #605 (ADR-005).
//
// Folds N responder_credential UltraHonk proofs into ONE proof, so a
// verifier (Soroban contract, EVM contract or another client) checks a
// single proof instead of N.
//
// Constraints enforced on top of the N in-circuit proof verifications:
//   - every inner proof was made against the SAME verification key, and
//     that key hashes to the public `inner_vk_hash` the verifier pins;
//   - all proofs are for the same incident / epoch / minimum level;
//   - the N nullifiers are pairwise distinct (no responder counted twice).
//
// Sizes are pinned to nargo 1.0.0-beta.9 + bb 0.87 (bb.js 0.87.9):
// UltraHonk proof = 456 fields, VK = 112 fields (measured by
// scripts/spikes/zk_aggregation_benchmark.js). Other versions break this.
//
// Build: nargo cannot build packages nested under circuits/Nargo.toml, so
// use circuits/recursive_verifier/build.sh.

use std::hash::poseidon2_permutation;

global N: u32 = 5;
global HONK_VK_SIZE: u32 = 112;
global HONK_PROOF_SIZE: u32 = 456;
// credential_commitment, min_level, now_epoch, incident_id, nullifier (return)
global INNER_PUBLIC_INPUTS: u32 = 5;
global PROOF_TYPE_HONK: u32 = 1;

fn main(
    verification_key: [Field; HONK_VK_SIZE],
    proofs: [[Field; HONK_PROOF_SIZE]; N],
    inner_vk_hash: pub Field,
    credential_commitments: pub [Field; N],
    nullifiers: pub [Field; N],
    min_level: pub Field,
    now_epoch: pub Field,
    incident_id: pub Field,
) {
    let vk_hash = hash_vk(verification_key);
    assert(vk_hash == inner_vk_hash, "Unexpected inner verification key");

    for i in 0..N {
        let public_inputs: [Field; INNER_PUBLIC_INPUTS] = [
            credential_commitments[i],
            min_level,
            now_epoch,
            incident_id,
            nullifiers[i],
        ];
        std::verify_proof_with_type(
            verification_key,
            proofs[i],
            public_inputs,
            vk_hash,
            PROOF_TYPE_HONK,
        );
        for j in 0..i {
            assert(nullifiers[i] != nullifiers[j], "Duplicate responder nullifier");
        }
    }
}

// Poseidon2 sponge (width 4, rate 3) over the VK fields. The stdlib hash
// moved out of std in 1.0.0-beta.x, so this is spelled out; the host mirrors
// it with bb.js `poseidon2Permutation` (src/utils/zkProver.js: hashVkFields).
fn hash_vk(vk: [Field; HONK_VK_SIZE]) -> Field {
    let mut state: [Field; 4] = [0, 0, 0, (HONK_VK_SIZE as Field) * 18446744073709551616];
    let mut k: u32 = 0;
    for i in 0..HONK_VK_SIZE {
        state[k] += vk[i];
        k += 1;
        if k == 3 {
            state = poseidon2_permutation(state, 4);
            k = 0;
        }
    }
    if k != 0 {
        state = poseidon2_permutation(state, 4);
    }
    state[0]
}

#[test]
fn vk_hash_depends_on_every_field() {
    let a: [Field; HONK_VK_SIZE] = [1; HONK_VK_SIZE];
    let mut b = a;
    b[HONK_VK_SIZE - 1] = 2;
    assert(hash_vk(a) != hash_vk(b));
}
