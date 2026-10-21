//! Per-account sequence nonces for replay protection on state-changing
//! invocations. Each account's nonce must be presented incrementing by
//! exactly 1 on every call that uses it; a reused or out-of-order nonce
//! panics rather than silently no-op'ing, so a replayed signed payload
//! can never be re-applied.

use soroban_sdk::{contracterror, Address, Env};

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NonceError {
    NonceReused = 1,
    NonceOutOfOrder = 2,
}

fn nonce_key(account: &Address) -> (soroban_sdk::Symbol, Address) {
    (soroban_sdk::symbol_short!("nonce"), account.clone())
}

/// Read the next expected nonce for `account` (0 if never used).
pub fn get_nonce(env: &Env, account: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&nonce_key(account))
        .unwrap_or(0u64)
}

/// Verify `provided` is exactly the next expected nonce for `account`,
/// then persist the increment. Panics via `Result::Err` on mismatch —
/// callers should propagate this as their own contract `Error`.
pub fn consume_nonce(env: &Env, account: &Address, provided: u64) -> Result<(), NonceError> {
    let expected = get_nonce(env, account);

    if provided < expected {
        return Err(NonceError::NonceReused);
    }
    if provided > expected {
        return Err(NonceError::NonceOutOfOrder);
    }

    env.storage()
        .persistent()
        .set(&nonce_key(account), &(expected + 1));

    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn first_nonce_is_zero() {
        let env = Env::default();
        let account = Address::generate(&env);
        assert_eq!(get_nonce(&env, &account), 0);
    }

    #[test]
    fn sequential_nonces_succeed() {
        let env = Env::default();
        let account = Address::generate(&env);
        assert!(consume_nonce(&env, &account, 0).is_ok());
        assert!(consume_nonce(&env, &account, 1).is_ok());
        assert_eq!(get_nonce(&env, &account), 2);
    }

    #[test]
    fn replayed_nonce_is_rejected() {
        let env = Env::default();
        let account = Address::generate(&env);
        assert!(consume_nonce(&env, &account, 0).is_ok());
        assert_eq!(consume_nonce(&env, &account, 0), Err(NonceError::NonceReused));
    }

    #[test]
    fn out_of_order_nonce_is_rejected() {
        let env = Env::default();
        let account = Address::generate(&env);
        assert_eq!(consume_nonce(&env, &account, 5), Err(NonceError::NonceOutOfOrder));
    }
}
