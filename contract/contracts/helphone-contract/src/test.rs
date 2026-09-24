#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env, String};

// ── Emergency request lifecycle ────────────────────────────────────

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
        &String::from_str(&env, "Ana"),
        &String::from_str(&env, "@ana"),
    );

    assert_eq!(request_id, 1);
    assert_eq!(client.get_request_count(), 1);
    assert_eq!(client.get_active_count(), 1);

    let request = client.get_request(&request_id).unwrap();
    assert_eq!(request.requester, requester);
    assert_eq!(request.status, Status::Pending);

    let responder_index = client.accept_request(
        &responder,
        &request_id,
        &12_346_000,
        &-76_543_000,
        &300,
    );

    assert_eq!(responder_index, 0);
    assert_eq!(client.get_responder_count(&request_id), 1);

    let accepted = client.get_request(&request_id).unwrap();
    assert_eq!(accepted.status, Status::Enroute);

    let saved_responder = client.get_responder(&request_id, &responder_index).unwrap();
    assert_eq!(saved_responder.responder, responder);
    assert_eq!(saved_responder.eta_seconds, 300);
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
    assert_eq!(record.proof_fingerprint, String::from_str(&env, "nullifier-xyz"));
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
