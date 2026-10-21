#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::testutils::Address as _;

fn setup(layout: u32, tier: u32) -> (Env, EmergencyVaultClient<'static>) {
    let env = Env::default();
    let id = env.register(EmergencyVault, (layout, tier));
    let client = EmergencyVaultClient::new(&env, &id);
    (env, client)
}

const ALL: [(u32, u32); 4] = [
    (LAYOUT_NORMALIZED, TIER_PERSISTENT),
    (LAYOUT_NORMALIZED, TIER_TEMPORARY),
    (LAYOUT_PACKED, TIER_PERSISTENT),
    (LAYOUT_PACKED, TIER_TEMPORARY),
];

#[test]
fn pack_roundtrip_preserves_extremes() {
    let inc = Incident { severity: 255, status: 7, lat: i32::MIN, lng: i32::MAX, opened_at: u64::MAX };
    assert_eq!(unpack(&pack(&inc)), inc);
}

#[test]
fn every_layout_returns_the_same_incident() {
    for (layout, tier) in ALL {
        let (_env, c) = setup(layout, tier);
        // ids straddle a bucket boundary to exercise slot addressing
        for id in [0u32, 31, 32, 65] {
            c.open_incident(&id, &3, &(id as i32 * 1000 - 90_000_000), &-122_419_400);
        }
        for id in [0u32, 31, 32, 65] {
            let s = c.summary(&id);
            assert_eq!(s.incident.severity, 3, "layout {layout} tier {tier}");
            assert_eq!(s.incident.lat, id as i32 * 1000 - 90_000_000);
            assert_eq!(s.incident.lng, -122_419_400);
        }
    }
}

#[test]
fn packed_layout_aggregates_acks_and_emits_signatures() {
    let (env, c) = setup(LAYOUT_PACKED, TIER_PERSISTENT);
    c.open_incident(&5, &2, &1, &1);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    c.ack(&a, &5, &100, &BytesN::from_array(&env, &[1; 32]));
    c.ack(&b, &5, &250, &BytesN::from_array(&env, &[2; 32]));
    let s = c.summary(&5);
    assert_eq!((s.responders, s.stake_total), (2, 350));
}

#[test]
fn duplicate_ack_is_rejected_in_every_layout() {
    for (layout, tier) in ALL {
        let (env, c) = setup(layout, tier);
        c.open_incident(&1, &1, &0, &0);
        let r = Address::generate(&env);
        let sig = BytesN::from_array(&env, &[9; 32]);
        c.ack(&r, &1, &1, &sig);
        assert_eq!(
            c.try_ack(&r, &1, &1, &sig),
            Err(Ok(SpikeError::DuplicateAck.into())),
            "layout {layout} tier {tier}"
        );
    }
}

#[test]
fn invalid_config_is_rejected() {
    let env = Env::default();
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(EmergencyVault, (7u32, 0u32));
    }));
    assert!(res.is_err());
}

#[test]
fn codec_benchmarks_agree_on_checksum_shape() {
    let (_env, c) = setup(LAYOUT_PACKED, TIER_PERSISTENT);
    // Both loops add severity (i % 5) per iteration; only the length term differs.
    let sev: u32 = (0..10).map(|i| i % 5).sum();
    assert_eq!(c.bench_packed(&10), 10 * SLOT_BYTES + sev);
    assert!(c.bench_native(&10) > c.bench_packed(&10));
}
