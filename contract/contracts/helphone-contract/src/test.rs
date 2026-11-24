#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, Events as _},
    Address, Bytes, Env, Event as _, InvokeError, String,
};

// ── Emergency request lifecycle ────────────────────────────────────

/// Stand-in for a sealed envelope. The contract treats it as opaque bytes, so
/// the exact content is irrelevant to the contract's own behaviour.
fn sealed_payload(env: &Env) -> Bytes {
    Bytes::from_slice(env, b"{\"version\":1,\"ciphertext\":\"aabbcc\"}".as_slice())
}

/// Unwrap the `Error` out of a `try_create_request` result.
///
/// The generated client returns
/// `Result<Result<u64, _>, Result<Error, InvokeError>>`: the outer layer is the
/// invocation outcome and the inner one is the contract's own `Result`.
fn contract_error<T, E>(res: Result<Result<T, E>, Result<Error, InvokeError>>) -> Error
where
    T: core::fmt::Debug,
    E: core::fmt::Debug,
{
    match res {
        Err(Ok(e)) => e,
        Err(Err(e)) => panic!("expected a contract error, got an invoke error: {e:?}"),
        Ok(inner) => panic!("expected a contract error, call succeeded with {inner:?}"),
    }
}

#[test]
fn creates_and_accepts_request() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(HelPhone, (admin,));
    let client = HelPhoneClient::new(&env, &contract_id);

    let requester = Address::generate(&env);
    let responder = Address::generate(&env);

    let request_id = client.create_request(
        &requester,
        &12_345_678,
        &-76_543_210,
        &String::from_str(&env, "medical"),
        &sealed_payload(&env),
    );

    assert_eq!(request_id, 1);
    assert_eq!(client.get_request_count(), 1);
    assert_eq!(client.get_active_count(), 1);

    let request = client.get_request(&request_id).unwrap();
    assert_eq!(request.requester, requester);
    assert_eq!(request.status, Status::Pending);
    // The payload round-trips as opaque bytes and is never parsed.
    assert_eq!(request.encrypted_payload, sealed_payload(&env));

    let responder_index =
        client.accept_request(&responder, &request_id, &12_346_000, &-76_543_000, &300);

    assert_eq!(responder_index, 0);
    assert_eq!(client.get_responder_count(&request_id), 1);

    let accepted = client.get_request(&request_id).unwrap();
    assert_eq!(accepted.status, Status::Enroute);

    let saved_responder = client.get_responder(&request_id, &responder_index).unwrap();
    assert_eq!(saved_responder.responder, responder);
    assert_eq!(saved_responder.eta_seconds, 300);
}

#[test]
fn rejects_empty_encrypted_payload() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(HelPhone, (admin,));
    let client = HelPhoneClient::new(&env, &contract_id);
    let requester = Address::generate(&env);

    let res = client.try_create_request(
        &requester,
        &12_345_678,
        &-76_543_210,
        &String::from_str(&env, "medical"),
        &Bytes::new(&env),
    );

    assert_eq!(contract_error(res), Error::PayloadEmpty);
}

#[test]
fn rejects_oversized_encrypted_payload() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(HelPhone, (admin,));
    let client = HelPhoneClient::new(&env, &contract_id);
    let requester = Address::generate(&env);

    let oversized = [0u8; (MAX_ENCRYPTED_PAYLOAD_BYTES + 1) as usize];
    let res = client.try_create_request(
        &requester,
        &12_345_678,
        &-76_543_210,
        &String::from_str(&env, "medical"),
        &Bytes::from_slice(&env, oversized.as_slice()),
    );

    assert_eq!(contract_error(res), Error::PayloadTooLarge);
}

#[test]
fn rejects_empty_emergency_type() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(HelPhone, (admin,));
    let client = HelPhoneClient::new(&env, &contract_id);
    let requester = Address::generate(&env);

    let res = client.try_create_request(
        &requester,
        &12_345_678,
        &-76_543_210,
        &String::from_str(&env, ""),
        &sealed_payload(&env),
    );

    assert_eq!(contract_error(res), Error::EmergencyTypeInvalid);
}

#[test]
fn rejects_overlong_emergency_type() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(HelPhone, (admin,));
    let client = HelPhoneClient::new(&env, &contract_id);
    let requester = Address::generate(&env);

    let long = "x".repeat((MAX_EMERGENCY_TYPE_BYTES + 1) as usize);
    let res = client.try_create_request(
        &requester,
        &12_345_678,
        &-76_543_210,
        &String::from_str(&env, &long),
        &sealed_payload(&env),
    );

    assert_eq!(contract_error(res), Error::EmergencyTypeInvalid);
}

#[test]
fn accepts_a_payload_exactly_at_the_size_limit() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(HelPhone, (admin,));
    let client = HelPhoneClient::new(&env, &contract_id);
    let requester = Address::generate(&env);

    let at_limit = [7u8; MAX_ENCRYPTED_PAYLOAD_BYTES as usize];
    let id = client.create_request(
        &requester,
        &12_345_678,
        &-76_543_210,
        &String::from_str(&env, "medical"),
        &Bytes::from_slice(&env, at_limit.as_slice()),
    );

    assert_eq!(id, 1);
    let request = client.get_request(&id).unwrap();
    assert_eq!(
        request.encrypted_payload,
        Bytes::from_slice(&env, at_limit.as_slice()),
    );
}

#[test]
fn records_expert_verification_history() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(HelPhone, (admin,));
    let client = HelPhoneClient::new(&env, &contract_id);

    let wallet = Address::generate(&env);

    let count = client.record_expert_verification(
        &wallet,
        &String::from_str(&env, "request_created"),
        &String::from_str(&env, "tx-abc123"),
        &String::from_str(&env, "nullifier-xyz"),
    );

    assert_eq!(count, 1);
    assert_eq!(client.get_expert_verification_count(&wallet), 1);

    let record = client.get_expert_verification(&wallet, &0).unwrap();
    assert_eq!(record.wallet, wallet);
    assert_eq!(record.action, String::from_str(&env, "request_created"));
    assert_eq!(record.tx_hash, String::from_str(&env, "tx-abc123"));
    assert_eq!(
        record.proof_fingerprint,
        String::from_str(&env, "nullifier-xyz")
    );
}

// ── Bounded verification history (ring buffer, #531) ───────────────

const CAP: u32 = VERIFICATION_CAPACITY;

fn setup() -> (Env, Address, HelPhoneClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(HelPhone, (admin,));
    let client = HelPhoneClient::new(&env, &contract_id);
    (env, contract_id, client)
}

/// Decimal digits of `n` (no_std has no `to_string`).
fn tx_of(env: &Env, n: u32) -> String {
    let mut tag = [0u8; 10];
    let mut len = 0;
    let mut v = n;
    loop {
        tag[len] = b'0' + (v % 10) as u8;
        len += 1;
        v /= 10;
        if v == 0 {
            break;
        }
    }
    tag[..len].reverse();
    String::from_bytes(env, &tag[..len])
}

/// Record verification number `n`, tagging it so it can be identified later.
fn record(env: &Env, client: &HelPhoneClient, wallet: &Address, n: u32) -> u32 {
    client.record_expert_verification(
        wallet,
        &String::from_str(env, "action"),
        &tx_of(env, n),
        &String::from_str(env, "fp"),
    )
}

#[test]
fn capacity_is_500() {
    let (_env, _id, client) = setup();
    assert_eq!(VERIFICATION_CAPACITY, 500);
    assert_eq!(client.get_expert_verification_capacity(), 500);
}

#[test]
fn nothing_is_evicted_up_to_capacity() {
    let (env, _id, client) = setup();
    let wallet = Address::generate(&env);

    for n in 0..CAP {
        assert_eq!(record(&env, &client, &wallet, n), n + 1);
    }
    assert!(
        env.events().all().events().is_empty(),
        "filling the buffer to capacity must not evict anything"
    );

    assert_eq!(client.get_expert_verification_count(&wallet), CAP);
    assert_eq!(client.get_expert_verification_oldest(&wallet), 0);
    assert_eq!(
        client.get_expert_verification(&wallet, &0).unwrap().tx_hash,
        tx_of(&env, 0)
    );
    assert_eq!(
        client
            .get_expert_verification(&wallet, &(CAP - 1))
            .unwrap()
            .tx_hash,
        tx_of(&env, CAP - 1)
    );
    assert!(client.get_expert_verification(&wallet, &CAP).is_none());
}

#[test]
fn the_501st_entry_evicts_the_oldest_and_emits_an_event() {
    let (env, contract_id, client) = setup();
    let wallet = Address::generate(&env);
    for n in 0..CAP {
        record(&env, &client, &wallet, n);
    }
    let oldest = client.get_expert_verification(&wallet, &0).unwrap();

    // The event comes from the call that overflows the buffer.
    assert_eq!(record(&env, &client, &wallet, CAP), CAP + 1);

    assert_eq!(
        env.events().all(),
        [Evicted {
            wallet: wallet.clone(),
            index: 0,
            record: oldest,
        }
        .to_xdr(&env, &contract_id)]
    );
    assert_eq!(client.get_expert_verification_count(&wallet), CAP + 1);
    assert_eq!(client.get_expert_verification_oldest(&wallet), 1);
    assert!(
        client.get_expert_verification(&wallet, &0).is_none(),
        "index 0 is evicted"
    );
    assert_eq!(
        client.get_expert_verification(&wallet, &1).unwrap().tx_hash,
        tx_of(&env, 1)
    );
    assert_eq!(
        client
            .get_expert_verification(&wallet, &CAP)
            .unwrap()
            .tx_hash,
        tx_of(&env, CAP),
        "the new entry landed in the freed slot"
    );
}

#[test]
fn each_eviction_event_names_the_entry_it_displaced() {
    let (env, contract_id, client) = setup();
    let wallet = Address::generate(&env);
    for n in 0..CAP {
        record(&env, &client, &wallet, n);
    }

    for extra in 0..3u32 {
        let displaced = client.get_expert_verification(&wallet, &extra).unwrap();
        record(&env, &client, &wallet, CAP + extra);
        assert_eq!(
            env.events().all(),
            [Evicted {
                wallet: wallet.clone(),
                index: extra,
                record: displaced,
            }
            .to_xdr(&env, &contract_id)],
            "eviction #{extra}"
        );
    }
}

#[test]
fn wallets_have_independent_buffers() {
    let (env, _id, client) = setup();
    let busy = Address::generate(&env);
    let quiet = Address::generate(&env);

    record(&env, &client, &quiet, 7);
    for n in 0..CAP + 10 {
        record(&env, &client, &busy, n);
    }

    assert_eq!(client.get_expert_verification_oldest(&busy), 10);
    assert_eq!(client.get_expert_verification_count(&quiet), 1);
    assert_eq!(client.get_expert_verification_oldest(&quiet), 0);
    assert_eq!(
        client.get_expert_verification(&quiet, &0).unwrap().tx_hash,
        tx_of(&env, 7)
    );
}

#[test]
fn verification_listing_is_capped_by_what_is_retained() {
    let (env, _id, client) = setup();
    let wallet = Address::generate(&env);
    for n in 0..CAP + 25 {
        record(&env, &client, &wallet, n);
    }

    // Lifetime total is 525, but only 500 can be read back.
    assert_eq!(client.get_expert_verification_count(&wallet), CAP + 25);
    assert_eq!(client.get_expert_verifications(&wallet, &10_000), CAP);
    assert_eq!(client.get_expert_verifications(&wallet, &10), 10);
}

#[test]
fn history_written_before_the_ring_buffer_still_reads_back() {
    let (env, contract_id, client) = setup();
    let wallet = Address::generate(&env);

    // Lay down entries exactly as the old unbounded code did.
    env.as_contract(&contract_id, || {
        for n in 0..3u32 {
            let ev = ExpertVerification {
                wallet: wallet.clone(),
                action: String::from_str(&env, "legacy"),
                tx_hash: tx_of(&env, n),
                proof_fingerprint: String::from_str(&env, "fp"),
                recorded_at: 1,
            };
            env.storage()
                .persistent()
                .set(&(symbol_short!("ev"), wallet.clone(), n), &ev);
        }
        env.storage()
            .persistent()
            .set(&(symbol_short!("evcount"), wallet.clone()), &3u32);
    });

    assert_eq!(client.get_expert_verification_count(&wallet), 3);
    assert_eq!(
        client.get_expert_verification(&wallet, &2).unwrap().tx_hash,
        tx_of(&env, 2)
    );
    assert_eq!(record(&env, &client, &wallet, 99), 4);
    assert_eq!(
        client.get_expert_verification(&wallet, &3).unwrap().tx_hash,
        tx_of(&env, 99)
    );
}

#[test]
fn recording_extends_the_rent_of_what_it_touches() {
    let (env, contract_id, client) = setup();
    let wallet = Address::generate(&env);
    record(&env, &client, &wallet, 0);

    env.as_contract(&contract_id, || {
        let storage = env.storage().persistent();
        let slot = (symbol_short!("ev"), wallet.clone(), 0u32);
        let count = (symbol_short!("evcount"), wallet.clone());
        assert!(storage.get_ttl(&slot) >= crate::ring_buffer::TTL_EXTEND_TO);
        assert!(storage.get_ttl(&count) >= crate::ring_buffer::TTL_EXTEND_TO);
    });
}

// ── Two-step ownership transfer ────────────────────────────────────

#[test]
fn propose_and_accept_transfer_changes_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let new_owner = Address::generate(&env);

    let contract_id = env.register(HelPhone, (admin.clone(),));
    let client = HelPhoneClient::new(&env, &contract_id);

    // Initially no pending transfer
    assert_eq!(client.get_pending_owner(), None);
    assert_eq!(client.get_admin(), Some(admin.clone()));

    // Step 1: current admin proposes transfer
    client.propose_transfer(&admin, &new_owner);
    assert_eq!(client.get_pending_owner(), Some(new_owner.clone()));
    // Admin unchanged until accept
    assert_eq!(client.get_admin(), Some(admin.clone()));

    // Step 2: new owner accepts
    client.accept_transfer(&new_owner);
    assert_eq!(client.get_admin(), Some(new_owner.clone()));
    // Pending slot cleared
    assert_eq!(client.get_pending_owner(), None);
}

#[test]
fn propose_transfer_overwrites_previous_pending() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);

    let contract_id = env.register(HelPhone, (admin.clone(),));
    let client = HelPhoneClient::new(&env, &contract_id);

    client.propose_transfer(&admin, &first);
    assert_eq!(client.get_pending_owner(), Some(first));

    // Overwrite with second candidate (typo-correction scenario)
    client.propose_transfer(&admin, &second);
    assert_eq!(client.get_pending_owner(), Some(second));
}

#[test]
fn non_admin_cannot_propose_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    let victim = Address::generate(&env);

    let contract_id = env.register(HelPhone, (admin,));
    let client = HelPhoneClient::new(&env, &contract_id);

    let result = client.try_propose_transfer(&attacker, &victim);
    assert!(result.is_err());
}

#[test]
fn wrong_address_cannot_accept_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let intended = Address::generate(&env);
    let interloper = Address::generate(&env);

    let contract_id = env.register(HelPhone, (admin.clone(),));
    let client = HelPhoneClient::new(&env, &contract_id);

    client.propose_transfer(&admin, &intended);

    let result = client.try_accept_transfer(&interloper);
    assert!(result.is_err());

    // Admin still unchanged
    assert_eq!(client.get_admin(), Some(admin));
}

#[test]
fn accept_without_pending_transfer_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(HelPhone, (admin.clone(),));
    let client = HelPhoneClient::new(&env, &contract_id);

    let result = client.try_accept_transfer(&admin);
    assert!(result.is_err());
}

#[test]
fn admin_can_revoke_pending_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let new_owner = Address::generate(&env);

    let contract_id = env.register(HelPhone, (admin.clone(),));
    let client = HelPhoneClient::new(&env, &contract_id);

    client.propose_transfer(&admin, &new_owner);
    assert_eq!(client.get_pending_owner(), Some(new_owner));

    // Current admin revokes
    client.revoke_transfer(&admin);
    assert_eq!(client.get_pending_owner(), None);
    assert_eq!(client.get_admin(), Some(admin));
}

#[test]
fn nominated_owner_can_decline_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let new_owner = Address::generate(&env);

    let contract_id = env.register(HelPhone, (admin.clone(),));
    let client = HelPhoneClient::new(&env, &contract_id);

    client.propose_transfer(&admin, &new_owner);

    // Nominated owner declines by revoking
    client.revoke_transfer(&new_owner);
    assert_eq!(client.get_pending_owner(), None);
    assert_eq!(client.get_admin(), Some(admin));
}

#[test]
fn revoke_without_pending_transfer_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(HelPhone, (admin.clone(),));
    let client = HelPhoneClient::new(&env, &contract_id);

    let result = client.try_revoke_transfer(&admin);
    assert!(result.is_err());
}

#[test]
fn unrelated_address_cannot_revoke_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let new_owner = Address::generate(&env);
    let random = Address::generate(&env);

    let contract_id = env.register(HelPhone, (admin.clone(),));
    let client = HelPhoneClient::new(&env, &contract_id);

    client.propose_transfer(&admin, &new_owner);
    let result = client.try_revoke_transfer(&random);
    assert!(result.is_err());

    // Transfer still pending
    assert_eq!(client.get_pending_owner(), Some(new_owner));
}
