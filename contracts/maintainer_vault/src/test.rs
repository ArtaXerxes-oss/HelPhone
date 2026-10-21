#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Env};

fn setup(env: &Env, fee_bps: u32) -> (MaintainerVaultClient<'_>, token::Client<'_>, Address) {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let payer = Address::generate(env);
    StellarAssetClient::new(env, &sac.address()).mint(&payer, &1_000_000);
    let id = env.register(MaintainerVault, (admin, sac.address(), fee_bps));
    (MaintainerVaultClient::new(env, &id), token::Client::new(env, &sac.address()), payer)
}

fn hash(env: &Env, n: u8) -> BytesN<32> {
    BytesN::from_array(env, &[n; 32])
}

#[test]
fn collects_fee_and_disburses_pro_rata() {
    let env = Env::default();
    let (vault, token, payer) = setup(&env, 100); // 1%
    let (a, b) = (Address::generate(&env), Address::generate(&env));
    vault.register_maintainer(&hash(&env, 1), &a, &3);
    vault.register_maintainer(&hash(&env, 2), &b, &1);

    assert_eq!(vault.collect_fee(&payer, &100_000), 1_000);
    assert_eq!(token.balance(&vault.address), 1_000);

    assert_eq!(vault.disburse(), 1_000);
    assert_eq!(token.balance(&a), 750);
    assert_eq!(token.balance(&b), 250);

    let s = vault.stats();
    assert_eq!((s.total_collected, s.total_disbursed, s.pool, s.maintainers), (1_000, 1_000, 0, 2));
}

#[test]
fn rounding_dust_stays_in_pool() {
    let env = Env::default();
    let (vault, token, payer) = setup(&env, 10_000); // 100%, so fee == gross
    for n in 1..=3 {
        vault.register_maintainer(&hash(&env, n), &Address::generate(&env), &1);
    }
    vault.collect_fee(&payer, &10);
    assert_eq!(vault.disburse(), 9);
    assert_eq!(vault.stats().pool, 1);
    assert_eq!(token.balance(&vault.address), 1);
}

#[test]
fn registry_lookup_and_removal() {
    let env = Env::default();
    let (vault, _, _) = setup(&env, 50);
    let m = Address::generate(&env);
    vault.register_maintainer(&hash(&env, 7), &m, &2);
    assert_eq!(vault.maintainer_of(&hash(&env, 7)).unwrap().address, m);
    vault.remove_maintainer(&hash(&env, 7));
    assert_eq!(vault.maintainer_of(&hash(&env, 7)), None);
    assert_eq!(vault.try_remove_maintainer(&hash(&env, 7)), Err(Ok(VaultError::NotRegistered)));
}

#[test]
fn rejects_bad_inputs() {
    let env = Env::default();
    let (vault, _, payer) = setup(&env, 50);
    assert_eq!(vault.try_set_fee_bps(&10_001), Err(Ok(VaultError::InvalidFee)));
    assert_eq!(vault.try_collect_fee(&payer, &0), Err(Ok(VaultError::InvalidAmount)));
    assert_eq!(
        vault.try_register_maintainer(&hash(&env, 1), &Address::generate(&env), &0),
        Err(Ok(VaultError::InvalidWeight))
    );
    assert_eq!(vault.disburse(), 0); // empty pool, empty registry
}
