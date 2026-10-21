//! Price-oracle adapter for SEP-40 compatible feeds (e.g. Reflector).
//!
//! Prices are quoted by the oracle in its base asset (usually USD) with
//! `decimals()` fractional digits, so converting `amount` of A into B is
//! `amount * price(A) / price(B)`. Every read is guarded against stale,
//! missing, non-positive or future-dated prices.

use soroban_sdk::{contractclient, contracttype, panic_with_error, Address, Env, Symbol};

use crate::DaoError;

/// Maximum age of an oracle price before it is rejected: 1 hour.
pub const MAX_PRICE_AGE_SECS: u64 = 60 * 60;
/// Tolerated clock skew for prices stamped slightly in the future.
pub const MAX_FUTURE_SKEW_SECS: u64 = 60;

/// SEP-40 asset identifier.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum OracleAsset {
    Stellar(Address),
    Other(Symbol),
}

/// SEP-40 price record.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// Minimal SEP-40 surface used by the DAO.
#[allow(dead_code)]
#[contractclient(name = "PriceOracleClient")]
pub trait PriceOracle {
    fn decimals(env: Env) -> u32;
    fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData>;
}

/// Latest price for `asset`; aborts with `StalePrice` when the feed has not
/// updated within [`MAX_PRICE_AGE_SECS`].
pub fn fetch_price(env: &Env, oracle: &Address, asset: &OracleAsset) -> i128 {
    let data = PriceOracleClient::new(env, oracle)
        .lastprice(asset)
        .unwrap_or_else(|| panic_with_error!(env, DaoError::PriceUnavailable));
    if data.price <= 0 {
        panic_with_error!(env, DaoError::InvalidPrice);
    }
    let now = env.ledger().timestamp();
    if data.timestamp > now.saturating_add(MAX_FUTURE_SKEW_SECS) {
        panic_with_error!(env, DaoError::InvalidPrice);
    }
    if now.saturating_sub(data.timestamp) > MAX_PRICE_AGE_SECS {
        panic_with_error!(env, DaoError::StalePrice);
    }
    data.price
}

/// `amount` of `from` expressed in `to`, rounded down. Both prices come from
/// the same feed so its decimals cancel out.
pub fn convert(
    env: &Env,
    oracle: &Address,
    from: &OracleAsset,
    to: &OracleAsset,
    amount: i128,
) -> i128 {
    if amount <= 0 {
        panic_with_error!(env, DaoError::InvalidAmount);
    }
    if from == to {
        return amount;
    }
    let p_from = fetch_price(env, oracle, from);
    let p_to = fetch_price(env, oracle, to);
    amount
        .checked_mul(p_from)
        .unwrap_or_else(|| panic_with_error!(env, DaoError::Overflow))
        / p_to
}
