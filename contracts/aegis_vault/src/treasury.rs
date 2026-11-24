//! Multi-asset treasury: per-asset reserves, daily disbursement caps and
//! target-weight rebalance planning. Pure bookkeeping — token movement stays
//! in `lib.rs`.

use soroban_sdk::{contracttype, Address, Env, Vec};

use crate::VaultError;

const SECONDS_PER_DAY: u64 = 86_400;
const BPS_DENOMINATOR: i128 = 10_000;

#[derive(Clone)]
#[contracttype]
enum TreasuryKey {
    Assets,
    Reserve(Address),
    DailyLimit(Address),
    /// (asset, UTC day index) -> amount disbursed that day.
    Spent(Address, u64),
    Target(Address),
}

fn day(env: &Env) -> u64 {
    env.ledger().timestamp() / SECONDS_PER_DAY
}

pub fn assets(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&TreasuryKey::Assets)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn is_registered(env: &Env, asset: &Address) -> bool {
    assets(env).contains(asset)
}

pub fn register_asset(env: &Env, asset: &Address) {
    let mut list = assets(env);
    if !list.contains(asset) {
        list.push_back(asset.clone());
        env.storage().instance().set(&TreasuryKey::Assets, &list);
    }
}

pub fn reserve(env: &Env, asset: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&TreasuryKey::Reserve(asset.clone()))
        .unwrap_or(0)
}

fn set_reserve(env: &Env, asset: &Address, amount: i128) {
    env.storage()
        .persistent()
        .set(&TreasuryKey::Reserve(asset.clone()), &amount);
}

pub fn credit(env: &Env, asset: &Address, amount: i128) -> Result<(), VaultError> {
    register_asset(env, asset);
    let next = reserve(env, asset)
        .checked_add(amount)
        .ok_or(VaultError::Overflow)?;
    set_reserve(env, asset, next);
    Ok(())
}

pub fn daily_limit(env: &Env, asset: &Address) -> i128 {
    env.storage()
        .instance()
        .get(&TreasuryKey::DailyLimit(asset.clone()))
        .unwrap_or(i128::MAX)
}

pub fn set_daily_limit(env: &Env, asset: &Address, limit: i128) {
    env.storage()
        .instance()
        .set(&TreasuryKey::DailyLimit(asset.clone()), &limit);
}

pub fn spent_today(env: &Env, asset: &Address) -> i128 {
    env.storage()
        .temporary()
        .get(&TreasuryKey::Spent(asset.clone(), day(env)))
        .unwrap_or(0)
}

pub fn remaining_today(env: &Env, asset: &Address) -> i128 {
    (daily_limit(env, asset) - spent_today(env, asset)).max(0)
}

/// Debits the reserve for an outgoing transfer and records it against today's
/// cap. Fails without mutating state when the cap or reserve is exceeded.
pub fn debit_disbursement(env: &Env, asset: &Address, amount: i128) -> Result<(), VaultError> {
    let spent = spent_today(env, asset)
        .checked_add(amount)
        .ok_or(VaultError::Overflow)?;
    if spent > daily_limit(env, asset) {
        return Err(VaultError::DailyLimitExceeded);
    }
    let held = reserve(env, asset);
    if held < amount {
        return Err(VaultError::InsufficientFunds);
    }
    set_reserve(env, asset, held - amount);
    let key = TreasuryKey::Spent(asset.clone(), day(env));
    env.storage().temporary().set(&key, &spent);
    // Keep the counter for two days so late readers still see today's spend.
    env.storage().temporary().extend_ttl(&key, 0, 2 * 17_280);
    Ok(())
}

pub fn target_weight(env: &Env, asset: &Address) -> u32 {
    env.storage()
        .instance()
        .get(&TreasuryKey::Target(asset.clone()))
        .unwrap_or(0)
}

pub fn set_target_weights(
    env: &Env,
    list: Vec<Address>,
    weights_bps: Vec<u32>,
) -> Result<(), VaultError> {
    if list.len() != weights_bps.len() {
        return Err(VaultError::InvalidWeights);
    }
    let mut total: i128 = 0;
    for w in weights_bps.iter() {
        total += w as i128;
    }
    if total > BPS_DENOMINATOR {
        return Err(VaultError::InvalidWeights);
    }
    for a in list.iter() {
        if !is_registered(env, &a) {
            return Err(VaultError::UnknownAsset);
        }
    }
    for (a, w) in list.iter().zip(weights_bps.iter()) {
        env.storage().instance().set(&TreasuryKey::Target(a), &w);
    }
    Ok(())
}

/// Signed per-asset amounts (asset units) to reach target weights by value.
pub fn rebalance_plan(env: &Env, prices: Vec<i128>) -> Result<Vec<i128>, VaultError> {
    let list = assets(env);
    if prices.len() != list.len() {
        return Err(VaultError::InvalidPrices);
    }
    let mut total_value: i128 = 0;
    for (a, p) in list.iter().zip(prices.iter()) {
        if p <= 0 {
            return Err(VaultError::InvalidPrices);
        }
        let v = reserve(env, &a).checked_mul(p).ok_or(VaultError::Overflow)?;
        total_value = total_value.checked_add(v).ok_or(VaultError::Overflow)?;
    }
    let mut plan = Vec::new(env);
    for (a, p) in list.iter().zip(prices.iter()) {
        let target_value = total_value
            .checked_mul(target_weight(env, &a) as i128)
            .ok_or(VaultError::Overflow)?
            / BPS_DENOMINATOR;
        let current_value = reserve(env, &a) * p;
        plan.push_back((target_value - current_value) / p);
    }
    Ok(plan)
}
