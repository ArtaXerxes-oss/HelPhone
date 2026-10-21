//! Open Source Sustainability Reserve (#587).
//!
//! A fixed 1% (`SUSTAINABILITY_FEE_BPS`) cut of HelPhone protocol transactions
//! is pulled — in a Stellar Asset Contract (SAC) token — into a reserve held
//! by the DAO contract. Maintainers of critical, underfunded open source
//! dependencies receive grants from that reserve only after a
//! `FundAllocation` proposal naming them passes a DAO vote and clears the
//! execution timelock.
//!
//! Lifecycle of a grant:
//!   propose_maintainer_grant -> cast_vote* -> execute_proposal
//!     -> auto-disbursed if the reserve covers it, otherwise stays `Pending`
//!        and anyone can retry `disburse_grant` once the reserve has grown.
//!
//! Entry points live in `lib.rs`; this module owns storage, accounting and
//! token movement.

use soroban_sdk::{contractevent, contracttype, token, Address, Env, String};

use crate::DaoError;

/// 1% of every gross protocol amount routed through `collect_fee`.
pub const SUSTAINABILITY_FEE_BPS: u32 = 100;
pub const BPS_DENOMINATOR: i128 = 10_000;

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum SustainabilityKey {
    Token,
    Reserve,
    Collected,
    Disbursed,
    GrantsProposed,
    GrantsDisbursed,
    MaintainersFunded,
    Grant(u64),                // proposal_id -> MaintainerGrant
    MaintainerTotal(Address),  // maintainer -> lifetime amount received
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum GrantStatus {
    Pending,
    Disbursed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct MaintainerGrant {
    pub proposal_id: u64,
    pub maintainer: Address,
    /// Dependency identifier, e.g. "npm:@stellar/stellar-sdk" or "cargo:soroban-sdk".
    pub package: String,
    pub amount: i128,
    pub status: GrantStatus,
    pub disbursed_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct SustainabilityStats {
    pub token: Option<Address>,
    pub fee_bps: u32,
    pub reserve: i128,
    pub total_collected: i128,
    pub total_disbursed: i128,
    pub grants_proposed: u32,
    pub grants_disbursed: u32,
    pub maintainers_funded: u32,
}

#[contractevent(topics = ["sus_fee"], data_format = "map")]
pub struct FeeCollectedEvent<'a> {
    #[topic]
    pub payer: &'a Address,
    pub gross_amount: &'a i128,
    pub fee: &'a i128,
}

#[contractevent(topics = ["sus_grant"], data_format = "map")]
pub struct GrantDisbursedEvent<'a> {
    #[topic]
    pub proposal_id: &'a u64,
    pub maintainer: &'a Address,
    pub package: &'a String,
    pub amount: &'a i128,
}

fn get_i128(env: &Env, key: &SustainabilityKey) -> i128 {
    env.storage().instance().get(key).unwrap_or(0)
}

fn get_u32(env: &Env, key: &SustainabilityKey) -> u32 {
    env.storage().instance().get(key).unwrap_or(0)
}

fn token_client(env: &Env) -> Result<token::Client<'_>, DaoError> {
    let addr: Address = env
        .storage()
        .instance()
        .get(&SustainabilityKey::Token)
        .ok_or(DaoError::SustainabilityNotConfigured)?;
    Ok(token::Client::new(env, &addr))
}

pub fn is_configured(env: &Env) -> bool {
    env.storage().instance().has(&SustainabilityKey::Token)
}

pub fn set_token(env: &Env, token: &Address) {
    env.storage().instance().set(&SustainabilityKey::Token, token);
}

/// Fee owed on `gross_amount` (rounds down; dust amounts pay nothing).
pub fn fee_for(gross_amount: i128) -> i128 {
    gross_amount * SUSTAINABILITY_FEE_BPS as i128 / BPS_DENOMINATOR
}

/// Pull the 1% sustainability fee on `gross_amount` from `payer` into the
/// reserve. Caller must have already required `payer`'s auth.
pub fn collect_fee(env: &Env, payer: &Address, gross_amount: i128) -> Result<i128, DaoError> {
    if gross_amount <= 0 {
        return Err(DaoError::InvalidAmount);
    }
    let token = token_client(env)?;
    let fee = fee_for(gross_amount);
    if fee == 0 {
        return Ok(0);
    }
    token.transfer(payer, &env.current_contract_address(), &fee);

    let s = env.storage().instance();
    s.set(&SustainabilityKey::Reserve, &(get_i128(env, &SustainabilityKey::Reserve) + fee));
    s.set(&SustainabilityKey::Collected, &(get_i128(env, &SustainabilityKey::Collected) + fee));

    FeeCollectedEvent { payer, gross_amount: &gross_amount, fee: &fee }.publish(env);
    Ok(fee)
}

/// Attach a grant request to a freshly created `FundAllocation` proposal.
pub fn record_grant(
    env: &Env,
    proposal_id: u64,
    maintainer: Address,
    package: String,
    amount: i128,
) -> Result<(), DaoError> {
    if amount <= 0 {
        return Err(DaoError::InvalidAmount);
    }
    if !is_configured(env) {
        return Err(DaoError::SustainabilityNotConfigured);
    }
    let grant = MaintainerGrant {
        proposal_id,
        maintainer,
        package,
        amount,
        status: GrantStatus::Pending,
        disbursed_at: 0,
    };
    env.storage().persistent().set(&SustainabilityKey::Grant(proposal_id), &grant);
    env.storage().instance().set(
        &SustainabilityKey::GrantsProposed,
        &(get_u32(env, &SustainabilityKey::GrantsProposed) + 1),
    );
    Ok(())
}

pub fn get_grant(env: &Env, proposal_id: u64) -> Option<MaintainerGrant> {
    env.storage().persistent().get(&SustainabilityKey::Grant(proposal_id))
}

/// Pay out a grant from the reserve. The caller is responsible for checking
/// that the backing proposal has been executed.
pub fn disburse(env: &Env, proposal_id: u64) -> Result<i128, DaoError> {
    let mut grant = get_grant(env, proposal_id).ok_or(DaoError::GrantNotFound)?;
    if grant.status == GrantStatus::Disbursed {
        return Err(DaoError::GrantAlreadyDisbursed);
    }
    let reserve = get_i128(env, &SustainabilityKey::Reserve);
    if grant.amount > reserve {
        return Err(DaoError::InsufficientReserve);
    }

    token_client(env)?.transfer(&env.current_contract_address(), &grant.maintainer, &grant.amount);

    grant.status = GrantStatus::Disbursed;
    grant.disbursed_at = env.ledger().timestamp();
    env.storage().persistent().set(&SustainabilityKey::Grant(proposal_id), &grant);

    let total_key = SustainabilityKey::MaintainerTotal(grant.maintainer.clone());
    let prior: i128 = env.storage().persistent().get(&total_key).unwrap_or(0);
    env.storage().persistent().set(&total_key, &(prior + grant.amount));

    let s = env.storage().instance();
    s.set(&SustainabilityKey::Reserve, &(reserve - grant.amount));
    s.set(&SustainabilityKey::Disbursed, &(get_i128(env, &SustainabilityKey::Disbursed) + grant.amount));
    s.set(&SustainabilityKey::GrantsDisbursed, &(get_u32(env, &SustainabilityKey::GrantsDisbursed) + 1));
    if prior == 0 {
        s.set(&SustainabilityKey::MaintainersFunded, &(get_u32(env, &SustainabilityKey::MaintainersFunded) + 1));
    }

    GrantDisbursedEvent {
        proposal_id: &proposal_id,
        maintainer: &grant.maintainer,
        package: &grant.package,
        amount: &grant.amount,
    }
    .publish(env);
    Ok(grant.amount)
}

pub fn maintainer_total(env: &Env, maintainer: Address) -> i128 {
    env.storage().persistent().get(&SustainabilityKey::MaintainerTotal(maintainer)).unwrap_or(0)
}

pub fn stats(env: &Env) -> SustainabilityStats {
    SustainabilityStats {
        token: env.storage().instance().get(&SustainabilityKey::Token),
        fee_bps: SUSTAINABILITY_FEE_BPS,
        reserve: get_i128(env, &SustainabilityKey::Reserve),
        total_collected: get_i128(env, &SustainabilityKey::Collected),
        total_disbursed: get_i128(env, &SustainabilityKey::Disbursed),
        grants_proposed: get_u32(env, &SustainabilityKey::GrantsProposed),
        grants_disbursed: get_u32(env, &SustainabilityKey::GrantsDisbursed),
        maintainers_funded: get_u32(env, &SustainabilityKey::MaintainersFunded),
    }
}
