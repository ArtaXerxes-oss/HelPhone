// responder_credential - inner circuit for spike #605 (ADR-005).
//
// A responder proves they hold a certification issued by a certifying
// authority, at or above the level an incident requires and not expired,
// without revealing who they are. Each proof also emits a per-incident
// nullifier so one credential cannot be counted twice for the same incident.
//
// The authority publishes `credential_commitment =
//   Poseidon2([responder_secret, cert_level, expires_at, authority_salt])[0]`
// for every credential it issues (e.g. into an on-chain registry).
//
// Five of these proofs are folded into one by ../recursive_verifier.

use std::hash::poseidon2_permutation;

fn main(
    // Private witnesses
    responder_secret: Field,
    cert_level: u8,
    expires_at: u64,
    authority_salt: Field,

    // Public inputs
    credential_commitment: pub Field,
    min_level: pub u8,
    now_epoch: pub u64,
    incident_id: pub Field,
) -> pub Field {
    let commitment = poseidon2_permutation(
        [responder_secret, cert_level as Field, expires_at as Field, authority_salt],
        4,
    )[0];
    assert(commitment == credential_commitment, "Unknown credential");
    assert(cert_level >= min_level, "Certification level too low");
    assert(expires_at > now_epoch, "Certification expired");

    // Nullifier: unique per (responder, incident), unlinkable across incidents.
    poseidon2_permutation([responder_secret, incident_id, 0, 0], 4)[0]
}

#[test]
fn valid_credential_produces_nullifier() {
    let secret = 0x1234;
    let salt = 0x99;
    let commitment = poseidon2_permutation([secret, 3, 2000000000, salt], 4)[0];
    let n = main(secret, 3, 2000000000, salt, commitment, 2, 1900000000, 7);
    assert(n == poseidon2_permutation([secret, 7, 0, 0], 4)[0]);
}

#[test(should_fail_with = "Certification expired")]
fn expired_credential_fails() {
    let commitment = poseidon2_permutation([1, 3, 100, 2], 4)[0];
    let _ = main(1, 3, 100, 2, commitment, 1, 200, 7);
}

#[test(should_fail_with = "Certification level too low")]
fn low_level_fails() {
    let commitment = poseidon2_permutation([1, 1, 300, 2], 4)[0];
    let _ = main(1, 1, 300, 2, commitment, 2, 200, 7);
}

#[test(should_fail_with = "Unknown credential")]
fn forged_commitment_fails() {
    let _ = main(1, 3, 300, 2, 12345, 1, 200, 7);
}
