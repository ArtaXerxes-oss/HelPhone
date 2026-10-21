#![no_std]
//! Maintainer Vault — routes a basis-point cut of HelPhone protocol fees (paid
//! in any Stellar Asset Contract token) to the open source maintainers of the
//! dependencies HelPhone ships. The registry maps a dependency package hash
//! (sha256 of e.g. "npm:@stellar/stellar-sdk") to the maintainer's address and
//! a payout weight. `disburse` is permissionless and splits the pooled fees
//! pro-rata by weight.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token, Address, BytesN,
    Env, Map, Symbol, Vec,
};

const BPS_DENOMINATOR: i128 = 10_000;

#[contract]
pub struct MaintainerVault;

#[contracterror]
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum VaultError {
    InvalidFee = 1,
    InvalidAmount = 2,
    InvalidWeight = 3,
    NotRegistered = 4,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Maintainer {
    pub address: Address,
    pub weight: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundingStats {
    pub fee_bps: u32,
    pub total_collected: i128,
    pub total_disbursed: i128,
    pub pool: i128,
    pub maintainers: u32,
}

fn key_admin() -> Symbol { symbol_short!("admin") }
fn key_token() -> Symbol { symbol_short!("token") }
fn key_fee() -> Symbol { symbol_short!("fee_bps") }
fn key_pool() -> Symbol { symbol_short!("pool") }
fn key_collected() -> Symbol { symbol_short!("collected") }
fn key_disbursed() -> Symbol { symbol_short!("disbursed") }
fn key_registry() -> Symbol { symbol_short!("registry") }

fn get_i128(env: &Env, key: Symbol) -> i128 {
    env.storage().instance().get(&key).unwrap_or(0)
}

fn admin(env: &Env) -> Address {
    env.storage().instance().get(&key_admin()).unwrap()
}

fn token_client(env: &Env) -> token::Client<'_> {
    let addr: Address = env.storage().instance().get(&key_token()).unwrap();
    token::Client::new(env, &addr)
}

// Note: whole registry is one persistent Map — fine for the few dozen
// critical deps we fund; switch to per-key entries + index if it grows to hundreds.
fn registry(env: &Env) -> Map<BytesN<32>, Maintainer> {
    env.storage()
        .persistent()
        .get(&key_registry())
        .unwrap_or_else(|| Map::new(env))
}

fn check_fee(fee_bps: u32) -> Result<(), VaultError> {
    if fee_bps as i128 > BPS_DENOMINATOR {
        return Err(VaultError::InvalidFee);
    }
    Ok(())
}

#[contractimpl]
impl MaintainerVault {
    pub fn __constructor(env: Env, admin: Address, token: Address, fee_bps: u32) {
        if check_fee(fee_bps).is_err() {
            panic_with_error!(&env, VaultError::InvalidFee);
        }
        let s = env.storage().instance();
        s.set(&key_admin(), &admin);
        s.set(&key_token(), &token);
        s.set(&key_fee(), &fee_bps);
    }

    pub fn set_fee_bps(env: Env, fee_bps: u32) -> Result<(), VaultError> {
        admin(&env).require_auth();
        check_fee(fee_bps)?;
        env.storage().instance().set(&key_fee(), &fee_bps);
        Ok(())
    }

    /// Register or update the maintainer for a dependency package hash.
    pub fn register_maintainer(env: Env, package_hash: BytesN<32>, maintainer: Address, weight: u32) -> Result<(), VaultError> {
        admin(&env).require_auth();
        if weight == 0 {
            return Err(VaultError::InvalidWeight);
        }
        let mut reg = registry(&env);
        reg.set(package_hash, Maintainer { address: maintainer, weight });
        env.storage().persistent().set(&key_registry(), &reg);
        Ok(())
    }

    pub fn remove_maintainer(env: Env, package_hash: BytesN<32>) -> Result<(), VaultError> {
        admin(&env).require_auth();
        let mut reg = registry(&env);
        if reg.remove(package_hash).is_none() {
            return Err(VaultError::NotRegistered);
        }
        env.storage().persistent().set(&key_registry(), &reg);
        Ok(())
    }

    pub fn maintainer_of(env: Env, package_hash: BytesN<32>) -> Option<Maintainer> {
        registry(&env).get(package_hash)
    }

    pub fn packages(env: Env) -> Vec<BytesN<32>> {
        registry(&env).keys()
    }

    /// Pull `fee_bps` of `gross_amount` from `payer` into the maintainer pool.
    /// Returns the fee actually collected.
    pub fn collect_fee(env: Env, payer: Address, gross_amount: i128) -> Result<i128, VaultError> {
        payer.require_auth();
        if gross_amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        let fee_bps: u32 = env.storage().instance().get(&key_fee()).unwrap_or(0);
        let fee = gross_amount * fee_bps as i128 / BPS_DENOMINATOR;
        if fee == 0 {
            return Ok(0);
        }
        token_client(&env).transfer(&payer, &env.current_contract_address(), &fee);
        let s = env.storage().instance();
        s.set(&key_pool(), &(get_i128(&env, key_pool()) + fee));
        s.set(&key_collected(), &(get_i128(&env, key_collected()) + fee));
        Ok(fee)
    }

    /// Split the pool across registered maintainers pro-rata by weight.
    /// Rounding dust stays in the pool for the next round. Returns amount paid.
    pub fn disburse(env: Env) -> i128 {
        let pool = get_i128(&env, key_pool());
        let reg = registry(&env);
        let total_weight: i128 = reg.values().iter().map(|m| m.weight as i128).sum();
        if pool <= 0 || total_weight == 0 {
            return 0;
        }
        let token = token_client(&env);
        let this = env.current_contract_address();
        let mut paid = 0i128;
        for m in reg.values().iter() {
            let share = pool * m.weight as i128 / total_weight;
            if share > 0 {
                token.transfer(&this, &m.address, &share);
                paid += share;
            }
        }
        let s = env.storage().instance();
        s.set(&key_pool(), &(pool - paid));
        s.set(&key_disbursed(), &(get_i128(&env, key_disbursed()) + paid));
        paid
    }

    pub fn stats(env: Env) -> FundingStats {
        FundingStats {
            fee_bps: env.storage().instance().get(&key_fee()).unwrap_or(0),
            total_collected: get_i128(&env, key_collected()),
            total_disbursed: get_i128(&env, key_disbursed()),
            pool: get_i128(&env, key_pool()),
            maintainers: registry(&env).len(),
        }
    }
}

#[cfg(test)]
mod test;
