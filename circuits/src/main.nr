// Coordinate encoding (avoids negative integers):
//   stored_lon = floor(real_lon * 1e7) + 1_800_000_000   range [0, 3_600_000_000]
//   stored_lat = floor(real_lat * 1e7) +   900_000_000   range [0, 1_800_000_000]
// Both fit in u64.

fn main(
    // Private witnesses -- never leave the client
    user_x: u64,      // encoded longitude
    user_y: u64,      // encoded latitude
    secret_id: Field, // user private seed

    // Public inputs -- committed to the proof, verified on-chain
    box_x_min: pub u64,
    box_x_max: pub u64,
    box_y_min: pub u64,
    box_y_max: pub u64,
    campaign_id:       pub Field,
    recipient_address: pub Field, // Stellar address as Field (decoded StrKey bytes -> Field)
) -> pub Field {

    // 1. Geofencing: four native u64 comparisons are the lowest-constraint
    // range proof measured in this spike; avoid distance/square-root gadgets.
    assert(user_x >= box_x_min, "Longitude below zone minimum");
    assert(user_x <= box_x_max, "Longitude above zone maximum");
    assert(user_y >= box_y_min, "Latitude below zone minimum");
    assert(user_y <= box_y_max, "Latitude above zone maximum");

    // 2. Nullifier = Poseidon2(secret_id, campaign_id)
    //    One valid claim per user per campaign. Unique without revealing identity.
    //    The smart contract stores this and rejects duplicates.
    // Poseidon2 permutation requires width-4 state (bb v0.87.0)
    let state = std::hash::poseidon2_permutation([secret_id, campaign_id, 0, 0], 4);
    let nullifier = state[0];

    // 3. Recipient binding
    //    recipient_address is a public input: the proof mathematically commits to it.
    //    Any attempt to swap the address after proof generation fails on-chain.
    assert(recipient_address != 0);

    nullifier
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn valid_inputs_satisfy_constraints() {
    let user_x: u64 = 1216364000;
    let user_y: u64 = 553656000;
    let secret_id: Field = 0x0000000000000000000000000000000000000000000000000000000000001337;

    let box_x_min: u64 = 1215864000;
    let box_x_max: u64 = 1216864000;
    let box_y_min: u64 = 553156000;
    let box_y_max: u64 = 554156000;
    let campaign_id: Field = 1;
    let recipient_address: Field = 0x000000000000000000000000000000000000000000000000000000000000CAFE;

    let result = main(user_x, user_y, secret_id, box_x_min, box_x_max, box_y_min, box_y_max, campaign_id, recipient_address);

    // Nullifier should be non-zero (Poseidon2 output)
    assert(result != 0);
}

#[test(should_panic)]
fn user_outside_zone_fails() {
    let user_x: u64 = 0; // outside any valid zone
    let user_y: u64 = 0;
    let secret_id: Field = 1;

    let box_x_min: u64 = 1215864000;
    let box_x_max: u64 = 1216864000;
    let box_y_min: u64 = 553156000;
    let box_y_max: u64 = 554156000;
    let campaign_id: Field = 1;
    let recipient_address: Field = 0xCAFE;

    // Should fail: user_x < box_x_min
    let _ = main(user_x, user_y, secret_id, box_x_min, box_x_max, box_y_min, box_y_max, campaign_id, recipient_address);
}

#[test(should_panic)]
fn zero_recipient_address_fails() {
    let user_x: u64 = 1216364000;
    let user_y: u64 = 553656000;
    let secret_id: Field = 1;

    let box_x_min: u64 = 1215864000;
    let box_x_max: u64 = 1216864000;
    let box_y_min: u64 = 553156000;
    let box_y_max: u64 = 554156000;
    let campaign_id: Field = 1;
    let recipient_address: Field = 0; // zero = invalid

    // Should fail: assert(recipient_address != 0)
    let _ = main(user_x, user_y, secret_id, box_x_min, box_x_max, box_y_min, box_y_max, campaign_id, recipient_address);
}
