#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{self, StellarAssetClient},
    Address, Env, String, Vec as SorobanVec,
};

const T0: u64 = 1_000_000;


struct Setup<'a> {
    dao: HelPhoneDaoClient<'a>,
    admin: Address,
    gov: token::Client<'a>,
    reserve: token::Client<'a>,
}

fn setup(env: &Env) -> Setup<'_> {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let gov = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let reserve = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let id = env.register(HelPhoneDao, (admin.clone(), gov.clone()));
    Setup {
        dao: HelPhoneDaoClient::new(env, &id),
        admin,
        gov: token::Client::new(env, &gov),
        reserve: token::Client::new(env, &reserve),
    }
}

fn mint(env: &Env, token: &token::Client, to: &Address, amount: i128) {
    StellarAssetClient::new(env, &token.address).mint(to, &amount);
}

fn s(env: &Env, v: &str) -> String {
    String::from_str(env, v)
}

/// Voter holding the whole voting supply, so any For vote passes quorum.
fn voter(env: &Env, t: &Setup) -> Address {
    let v = Address::generate(env);
    mint(env, &t.gov, &v, 1_000);
    t.dao.set_voting_supply(&t.admin, &1_000);
    v
}

fn pass_timelock(env: &Env) {
    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + VOTING_PERIOD_SECS + EXECUTION_DELAY_SECS + 1);
}

#[contractimpl]
impl MockOracle {
    pub fn decimals(_env: Env) -> u32 {
        14
    }
    pub fn set_price(env: Env, asset: OracleAsset, price: i128, timestamp: u64) {
        env.storage()
            .instance()
            .set(&OracleKey::Price(asset), &PriceData { price, timestamp });
    }
    pub fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData> {
        env.storage().instance().get(&OracleKey::Price(asset))
    }
}

/// Governance token exposing the two calls the DAO makes.
#[contract]
struct MockGovToken;

#[contractimpl]
impl MockGovToken {
    pub fn set_balance(env: Env, who: Address, amount: i128) {
        env.storage().instance().set(&who, &amount);
    }
    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().instance().get(&id).unwrap_or(0)
    }
    pub fn total_supply(_env: Env) -> i128 {
        1_000
    }
}

struct Ctx<'a> {
    env: Env,
    dao: HelPhoneDaoClient<'a>,
    admin: Address,
    gov: Address,
}

fn ctx<'a>() -> Ctx<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let admin = Address::generate(&env);
    let gov = env.register(MockGovToken, ());
    let id = env.register(HelPhoneDao, (admin.clone(), gov.clone()));
    let dao = HelPhoneDaoClient::new(&env, &id);
    Ctx { env, dao, admin, gov }
}

fn sac(env: &Env) -> Address {
    env.register_stellar_asset_contract_v2(Address::generate(env)).address()
}

// ── Governance (constructor + proposal lifecycle) ──────────────────

#[test]
fn constructor_sets_admin_and_token() {
    let env = Env::default();
    let t = setup(&env);
    assert_eq!(t.dao.get_admin(), Some(t.admin.clone()));
    assert_eq!(t.dao.get_governance_token(), Some(t.gov.address.clone()));
    assert_eq!(t.dao.get_proposal_count(), 0);
}

#[test]
fn governance_params_are_correct() {
    let env = Env::default();
    let t = setup(&env);
    let (voting_period, execution_delay, quorum, pass_threshold) = t.dao.get_governance_params();
}

#[test]
fn reads_initial_config_ctx() {
    let c = ctx();
    assert_eq!(c.dao.get_admin(), Some(c.admin.clone()));
    assert_eq!(c.dao.get_governance_token(), Some(c.gov.clone()));
    assert_eq!(c.dao.get_proposal_count(), 0);
    assert_eq!(c.dao.get_governance_params(), (3 * 86_400, 86_400, 20, 50));
    assert_eq!(c.dao.get_oracle(), None);
}

fn propose(c: &Ctx, proposer: &Address) -> u64 {
    c.dao.create_proposal(
        proposer,
        &String::from_str(&c.env, "Fund zone"),
        &String::from_str(&c.env, "desc"),
        &ProposalType::FundAllocation,
        &Bytes::new(&c.env),
    )
}

fn holder(c: &Ctx, weight: i128) -> Address {
    let a = Address::generate(&c.env);
    MockGovTokenClient::new(&c.env, &c.gov).set_balance(&a, &weight);
    a
}

#[test]
fn proposal_passes_and_executes_after_timelock() {
    let c = ctx();
    let voter = holder(&c, 300);
    let id = propose(&c, &voter);
    assert_eq!(id, 1);
    assert_eq!(c.dao.get_total_supply_at(&id), 1_000);

    c.dao.cast_vote(&voter, &id, &VoteDirection::For);
    assert_eq!(c.dao.get_vote(&id, &voter).unwrap().weight, 300);
    assert_eq!(c.dao.get_proposal(&id).unwrap().for_votes, 300);

    // Voting still open, so finalization is refused.
    assert_eq!(c.dao.try_finalize_proposal(&id), Err(Ok(DaoError::VotingClosed)));

    let ends = c.dao.get_proposal(&id).unwrap().voting_ends;
    c.env.ledger().set_timestamp(ends + 1);
    assert_eq!(c.dao.finalize_proposal(&id), ProposalStatus::Passed);
    // Finalizing again is a no-op that reports the settled status.
    assert_eq!(c.dao.finalize_proposal(&id), ProposalStatus::Passed);

    assert_eq!(c.dao.try_execute_proposal(&id), Err(Ok(DaoError::TimelockNotExpired)));
    c.env.ledger().set_timestamp(ends + 86_400);
    c.dao.execute_proposal(&id);
    assert_eq!(c.dao.get_proposal(&id).unwrap().status, ProposalStatus::Executed);
    assert_eq!(c.dao.get_executed_proposals().len(), 1);
    assert_eq!(c.dao.try_execute_proposal(&id), Err(Ok(DaoError::AlreadyExecuted)));
}

#[test]
fn execute_finalizes_an_unsettled_passed_proposal() {
    let c = ctx();
    let voter = holder(&c, 300);
    let id = propose(&c, &voter);
    c.dao.cast_vote(&voter, &id, &VoteDirection::For);
    assert_eq!(c.dao.try_execute_proposal(&id), Err(Ok(DaoError::VotingClosed)));
    let ends = c.dao.get_proposal(&id).unwrap().voting_ends;
    c.env.ledger().set_timestamp(ends + 86_400 + 1);
    c.dao.execute_proposal(&id);
    assert_eq!(c.dao.get_proposal(&id).unwrap().status, ProposalStatus::Executed);
}

#[test]
fn proposal_without_quorum_or_majority_fails() {
    let c = ctx();
    let small = holder(&c, 100); // 10% < 20% quorum
    let id = propose(&c, &small);
    c.dao.cast_vote(&small, &id, &VoteDirection::For);
    let ends = c.dao.get_proposal(&id).unwrap().voting_ends;
    c.env.ledger().set_timestamp(ends + 1);
    assert_eq!(c.dao.finalize_proposal(&id), ProposalStatus::Failed);
    assert_eq!(c.dao.try_execute_proposal(&id), Err(Ok(DaoError::NotPassed)));

    c.env.ledger().set_timestamp(T0);
    let big = holder(&c, 400);
    let id2 = propose(&c, &big);
    c.dao.cast_vote(&big, &id2, &VoteDirection::Against);
    c.env.ledger().set_timestamp(ends + 1);
    assert_eq!(c.dao.finalize_proposal(&id2), ProposalStatus::Failed);
}

#[test]
fn voting_rules_are_enforced() {
    let c = ctx();
    let voter = holder(&c, 300);
    let nobody = Address::generate(&c.env);
    let id = propose(&c, &voter);

    assert_eq!(c.dao.try_cast_vote(&voter, &99, &VoteDirection::For), Err(Ok(DaoError::ProposalNotFound)));
    assert_eq!(c.dao.try_cast_vote(&nobody, &id, &VoteDirection::For), Err(Ok(DaoError::NotTokenHolder)));
    c.dao.cast_vote(&voter, &id, &VoteDirection::Abstain);
    assert_eq!(c.dao.get_proposal(&id).unwrap().abstain_votes, 300);
    assert_eq!(c.dao.try_cast_vote(&voter, &id, &VoteDirection::For), Err(Ok(DaoError::AlreadyVoted)));

    let ends = c.dao.get_proposal(&id).unwrap().voting_ends;
    c.env.ledger().set_timestamp(ends + 1);
    let late = holder(&c, 10);
    assert_eq!(c.dao.try_cast_vote(&late, &id, &VoteDirection::For), Err(Ok(DaoError::VotingClosed)));
}

#[test]
fn cancel_is_limited_to_proposer_or_admin() {
    let c = ctx();
    let proposer = holder(&c, 300);
    let id = propose(&c, &proposer);
    let stranger = Address::generate(&c.env);
    assert_eq!(c.dao.try_cancel_proposal(&stranger, &id), Err(Ok(DaoError::NotAdmin)));
    c.dao.cancel_proposal(&c.admin, &id);
    assert_eq!(c.dao.get_proposal(&id).unwrap().status, ProposalStatus::Cancelled);
    assert_eq!(c.dao.try_cancel_proposal(&proposer, &id), Err(Ok(DaoError::VotingClosed)));
    assert_eq!(c.dao.try_cancel_proposal(&proposer, &42), Err(Ok(DaoError::ProposalNotFound)));
}

#[test]
fn admin_controls_are_admin_only() {
    let c = ctx();
    let other = Address::generate(&c.env);
    let new_token = Address::generate(&c.env);

    assert_eq!(c.dao.try_set_governance_token(&other, &new_token), Err(Ok(DaoError::NotAdmin)));
    c.dao.set_governance_token(&c.admin, &new_token);
    assert_eq!(c.dao.get_governance_token(), Some(new_token));

    assert_eq!(c.dao.try_transfer_admin(&other, &other), Err(Ok(DaoError::NotAdmin)));
    c.dao.transfer_admin(&c.admin, &other);
    assert_eq!(c.dao.get_admin(), Some(other));
}

// ── Price oracle adapter (#543) ────────────────────────────────────

struct Oracle<'a> {
    c: Ctx<'a>,
    feed: MockOracleClient<'a>,
    xlm: Address,
    usdc: Address,
}

fn oracle<'a>() -> Oracle<'a> {
    let c = ctx();
    let feed_id = c.env.register(MockOracle, ());
    let feed = MockOracleClient::new(&c.env, &feed_id);
    let xlm = sac(&c.env);
    let usdc = sac(&c.env);
    c.dao.set_oracle(&c.admin, &feed_id);
    // 1 XLM = 0.12 USD, 1 USDC = 1.00 USD (feed decimals cancel out).
    feed.set_price(&OracleAsset::Stellar(xlm.clone()), &12_000_000_000_000, &T0);
    feed.set_price(&OracleAsset::Stellar(usdc.clone()), &100_000_000_000_000, &T0);
    Oracle { c, feed, xlm, usdc }
}

#[test]
fn set_oracle_is_admin_only() {
    let c = ctx();
    let feed = Address::generate(&c.env);
    assert_eq!(c.dao.try_set_oracle(&Address::generate(&c.env), &feed), Err(Ok(DaoError::NotAdmin)));
    c.dao.set_oracle(&c.admin, &feed);
    assert_eq!(c.dao.get_oracle(), Some(feed));
}

#[test]
fn quote_requires_an_oracle() {
    let c = ctx();
    let a = Address::generate(&c.env);
    let b = Address::generate(&c.env);
    assert_eq!(c.dao.try_quote_conversion(&a, &b, &100), Err(Ok(DaoError::OracleNotSet)));
}

    assert_eq!(voting_period, 3 * 24 * 60 * 60); // 3 days
    assert_eq!(execution_delay, 48 * 60 * 60);
    assert_eq!(quorum, 20); // 20%
    assert_eq!(pass_threshold, 50); // 50%
}

#[test]
fn collects_one_percent_into_reserve() {
    let env = Env::default();
    let t = setup(&env);
    t.dao.configure_sustainability(&t.admin, &t.reserve.address);
    let payer = Address::generate(&env);
    mint(&env, &t.reserve, &payer, 1_000_000);

    assert_eq!(t.dao.collect_sustainability_fee(&payer, &250_000), 2_500);
    assert_eq!(t.dao.collect_sustainability_fee(&payer, &99), 0); // below 1 unit of fee
    assert_eq!(t.reserve.balance(&t.dao.address), 2_500);
    assert_eq!(t.reserve.balance(&payer), 997_500);

    let st = t.dao.get_sustainability_stats();
    assert_eq!(st.fee_bps, 100);
    assert_eq!((st.reserve, st.total_collected, st.total_disbursed), (2_500, 2_500, 0));
    assert_eq!(st.token, Some(t.reserve.address.clone()));
}

#[test]
fn passed_grant_is_disbursed_on_execution() {
    let env = Env::default();
    let t = setup(&env);
    t.dao.configure_sustainability(&t.admin, &t.reserve.address);
    let payer = Address::generate(&env);
    mint(&env, &t.reserve, &payer, 10_000_000);
    t.dao.collect_sustainability_fee(&payer, &10_000_000); // reserve = 100_000

    let v = voter(&env, &t);
    let maintainer = Address::generate(&env);
    let pid = t.dao.propose_maintainer_grant(
        &v,
        &maintainer,
        &s(&env, "npm:@stellar/stellar-sdk"),
        &40_000,
        &s(&env, "Fund stellar-sdk"),
        &s(&env, "Critical dependency with a single maintainer"),
    );
    assert_eq!(t.dao.get_proposal(&pid).unwrap().proposal_type, ProposalType::FundAllocation);

    t.dao.cast_vote(&v, &pid, &VoteDirection::For);
    pass_timelock(&env);
    t.dao.execute_proposal(&pid);

    assert_eq!(t.reserve.balance(&maintainer), 40_000);
    let grant = t.dao.get_maintainer_grant(&pid).unwrap();
    assert_eq!(grant.status, sustainability::GrantStatus::Disbursed);
    assert_eq!(t.dao.get_maintainer_funding(&maintainer), 40_000);

    let st = t.dao.get_sustainability_stats();
    assert_eq!((st.reserve, st.total_disbursed), (60_000, 40_000));
    assert_eq!((st.grants_proposed, st.grants_disbursed, st.maintainers_funded), (1, 1, 1));
    assert_eq!(t.dao.try_disburse_grant(&pid), Err(Ok(DaoError::GrantAlreadyDisbursed)));
}

#[test]
fn underfunded_grant_stays_pending_until_reserve_grows() {
    let env = Env::default();
    let t = setup(&env);
    t.dao.configure_sustainability(&t.admin, &t.reserve.address);
    let payer = Address::generate(&env);
    mint(&env, &t.reserve, &payer, 10_000_000);

    let v = voter(&env, &t);
    let maintainer = Address::generate(&env);
    let pid = t.dao.propose_maintainer_grant(
        &v, &maintainer, &s(&env, "cargo:soroban-sdk"), &5_000, &s(&env, "t"), &s(&env, "d"),
    );
    t.dao.cast_vote(&v, &pid, &VoteDirection::For);
    pass_timelock(&env);
    t.dao.execute_proposal(&pid); // reserve is empty: execution still succeeds

    assert_eq!(t.dao.get_proposal(&pid).unwrap().status, ProposalStatus::Executed);
    assert_eq!(t.dao.get_maintainer_grant(&pid).unwrap().status, sustainability::GrantStatus::Pending);
    assert_eq!(t.dao.try_disburse_grant(&pid), Err(Ok(DaoError::InsufficientReserve)));

    t.dao.collect_sustainability_fee(&payer, &500_000); // reserve = 5_000
    assert_eq!(t.dao.disburse_grant(&pid), 5_000);
    assert_eq!(t.reserve.balance(&maintainer), 5_000);
}

#[test]
fn rejected_grant_cannot_be_disbursed() {
    let env = Env::default();
    let t = setup(&env);
    t.dao.configure_sustainability(&t.admin, &t.reserve.address);
    let v = voter(&env, &t);
    let pid = t.dao.propose_maintainer_grant(
        &v, &Address::generate(&env), &s(&env, "npm:x"), &1, &s(&env, "t"), &s(&env, "d"),
    );
    t.dao.cast_vote(&v, &pid, &VoteDirection::Against);
    pass_timelock(&env);

    assert_eq!(t.dao.try_execute_proposal(&pid), Err(Ok(DaoError::NotPassed)));
    assert_eq!(t.dao.try_disburse_grant(&pid), Err(Ok(DaoError::NotPassed)));
}

#[test]
fn rejects_bad_sustainability_inputs() {
    let env = Env::default();
    let t = setup(&env);
    let payer = Address::generate(&env);
    let who = Address::generate(&env);

    assert_eq!(
        t.dao.try_collect_sustainability_fee(&payer, &1_000),
        Err(Ok(DaoError::SustainabilityNotConfigured))
    );
    assert_eq!(
        t.dao.try_propose_maintainer_grant(&who, &who, &s(&env, "p"), &1, &s(&env, "t"), &s(&env, "d")),
        Err(Ok(DaoError::SustainabilityNotConfigured))
    );
    assert_eq!(
        t.dao.try_configure_sustainability(&who, &t.reserve.address),
        Err(Ok(DaoError::NotAdmin))
    );

    t.dao.configure_sustainability(&t.admin, &t.reserve.address);
    assert_eq!(t.dao.try_collect_sustainability_fee(&payer, &0), Err(Ok(DaoError::InvalidAmount)));
    assert_eq!(
        t.dao.try_propose_maintainer_grant(&who, &who, &s(&env, "p"), &0, &s(&env, "t"), &s(&env, "d")),
        Err(Ok(DaoError::InvalidAmount))
    );
    assert_eq!(t.dao.try_disburse_grant(&42), Err(Ok(DaoError::ProposalNotFound)));
}

#[test]
fn fn proposal_status_values() {
    assert_eq!(ProposalStatus::Active, ProposalStatus::Active);
    assert_eq!(ProposalStatus::Passed, ProposalStatus::Passed);
    assert_eq!(ProposalStatus::Failed, ProposalStatus::Failed);
    assert_eq!(ProposalStatus::Executed, ProposalStatus::Executed);
    assert_eq!(ProposalStatus::Cancelled, ProposalStatus::Cancelled);
    assert_eq!(ProposalStatus::Queued, ProposalStatus::Queued);
}

#[test]
fn queued_proposal_requires_security_threshold_to_cancel() {
    let (env, admin, token) = create_test_env();
    env.mock_all_auths();
    HelPhoneDao::__constructor(env.clone(), admin.clone(), token).unwrap();

    let guardian_a = Address::generate(&env);
    let guardian_b = Address::generate(&env);
    let mut guardians = SorobanVec::new(&env);
    guardians.push_back(guardian_a.clone());
    guardians.push_back(guardian_b.clone());
    HelPhoneDao::set_security_multisig(env.clone(), admin, guardians, 2).unwrap();

    let proposal_id = 7;
    let proposal = Proposal {
        id: proposal_id,
        proposer: guardian_a.clone(),
        title: String::from_str(&env, "upgrade"),
        description: String::from_str(&env, "test proposal"),
        proposal_type: ProposalType::General,
        status: ProposalStatus::Queued,
        created_at: 0,
        voting_starts: 0,
        voting_ends: 0,
        for_votes: 1,
        against_votes: 0,
        abstain_votes: 0,
        executable_payload: soroban_sdk::Bytes::new(&env),
    };
    env.storage()
        .persistent()
        .set(&DataKey::Proposal(proposal_id), &proposal);
    env.storage().persistent().set(
        &DataKey::Timelock(proposal_id),
        &TimelockState {
            queued_at: 0,
            execute_after: EXECUTION_DELAY_SECS,
        },
    );

    HelPhoneDao::approve_cancellation(env.clone(), guardian_a, proposal_id).unwrap();
    assert_eq!(
        HelPhoneDao::get_cancellation_approval_count(env.clone(), proposal_id),
        1
    );
    assert_eq!(
        HelPhoneDao::cancel_queued_proposal(env.clone(), proposal_id),
        Err(DaoError::InsufficientSecurityApprovals),
    );

    HelPhoneDao::approve_cancellation(env.clone(), guardian_b, proposal_id).unwrap();
    HelPhoneDao::cancel_queued_proposal(env.clone(), proposal_id).unwrap();
    assert_eq!(
        HelPhoneDao::get_proposal(env, proposal_id).unwrap().status,
        ProposalStatus::Cancelled,
    );
}

#[test]
fn security_multisig_rejects_duplicate_guardians_and_unreachable_threshold() {
    let (env, admin, token) = create_test_env();
    env.mock_all_auths();
    HelPhoneDao::__constructor(env.clone(), admin.clone(), token).unwrap();
    let guardian = Address::generate(&env);

    let mut duplicate = SorobanVec::new(&env);
    duplicate.push_back(guardian.clone());
    duplicate.push_back(guardian);
    assert_eq!(
        HelPhoneDao::set_security_multisig(env.clone(), admin.clone(), duplicate, 1),
        Err(DaoError::InvalidSecurityThreshold),
    );

    let one_key = SorobanVec::from_array(&env, [Address::generate(&env)]);
    assert_eq!(
        HelPhoneDao::set_security_multisig(env, admin, one_key, 2),
        Err(DaoError::InvalidSecurityThreshold),
    );
}

#[test]
fn tracks_price_updates() {
    let o = oracle();
    o.feed.set_price(&OracleAsset::Stellar(o.xlm.clone()), &24_000_000_000_000, &T0);
    assert_eq!(o.c.dao.quote_conversion(&o.xlm, &o.usdc, &10_000_000_000), 2_400_000_000);
}

#[test]
fn rejects_prices_older_than_one_hour() {
    let o = oracle();
    // Exactly one hour old is still acceptable…
    o.c.env.ledger().set_timestamp(T0 + MAX_PRICE_AGE_SECS);
    assert_eq!(o.c.dao.quote_conversion(&o.xlm, &o.usdc, &10_000_000_000), 1_200_000_000);
    // …one second more is stale.
    o.c.env.ledger().set_timestamp(T0 + MAX_PRICE_AGE_SECS + 1);
    assert_eq!(
        o.c.dao.try_quote_conversion(&o.xlm, &o.usdc, &10_000_000_000),
        Err(Ok(DaoError::StalePrice))
    );
    // A refreshed feed recovers.
    let now = T0 + MAX_PRICE_AGE_SECS + 1;
    o.feed.set_price(&OracleAsset::Stellar(o.xlm.clone()), &12_000_000_000_000, &now);
    o.feed.set_price(&OracleAsset::Stellar(o.usdc.clone()), &100_000_000_000_000, &now);
    assert_eq!(o.c.dao.quote_conversion(&o.xlm, &o.usdc, &10_000_000_000), 1_200_000_000);
}

#[test]
fn a_single_stale_leg_is_enough_to_reject() {
    let o = oracle();
    o.c.env.ledger().set_timestamp(T0 + 2 * 3_600);
    o.feed.set_price(&OracleAsset::Stellar(o.usdc.clone()), &100_000_000_000_000, &(T0 + 2 * 3_600));
    assert_eq!(
        o.c.dao.try_quote_conversion(&o.xlm, &o.usdc, &1_000),
        Err(Ok(DaoError::StalePrice))
    );
}

#[test]
fn rejects_missing_zero_negative_and_future_prices() {
    let o = oracle();
    let unpriced = Address::generate(&o.c.env);
    assert_eq!(o.c.dao.try_quote_conversion(&unpriced, &o.usdc, &10), Err(Ok(DaoError::PriceUnavailable)));

    o.feed.set_price(&OracleAsset::Stellar(o.xlm.clone()), &0, &T0);
    assert_eq!(o.c.dao.try_quote_conversion(&o.xlm, &o.usdc, &10), Err(Ok(DaoError::InvalidPrice)));
    o.feed.set_price(&OracleAsset::Stellar(o.xlm.clone()), &-5, &T0);
    assert_eq!(o.c.dao.try_quote_conversion(&o.xlm, &o.usdc, &10), Err(Ok(DaoError::InvalidPrice)));

    // Small clock skew is tolerated; large future timestamps are not.
    o.feed.set_price(&OracleAsset::Stellar(o.xlm.clone()), &12_000_000_000_000, &(T0 + 60));
    assert_eq!(o.c.dao.quote_conversion(&o.xlm, &o.usdc, &10_000_000_000), 1_200_000_000);
    o.feed.set_price(&OracleAsset::Stellar(o.xlm.clone()), &12_000_000_000_000, &(T0 + 61));
    assert_eq!(o.c.dao.try_quote_conversion(&o.xlm, &o.usdc, &10), Err(Ok(DaoError::InvalidPrice)));
}

#[test]
fn conversion_overflow_is_reported() {
    let o = oracle();
    assert_eq!(o.c.dao.try_quote_conversion(&o.xlm, &o.usdc, &i128::MAX), Err(Ok(DaoError::Overflow)));
}

#[test]
fn supports_non_stellar_oracle_symbols() {
    let o = oracle();
    let btc = OracleAsset::Other(soroban_sdk::Symbol::new(&o.c.env, "BTC"));
    o.feed.set_price(&btc, &6_000_000_000_000_000, &T0);
    // The DAO addresses assets by token contract, but the adapter handles both variants.
    let feed = o.c.dao.get_oracle().unwrap();
    let usdc = OracleAsset::Stellar(o.usdc.clone());
    o.c.env.as_contract(&o.c.dao.address, || {
        assert_eq!(oracle::convert(&o.c.env, &feed, &btc, &usdc, 2), 120);
    });
}

#[test]
fn disburse_aid_pays_the_converted_amount() {
    let o = oracle();
    let recipient = Address::generate(&o.c.env);
    StellarAssetClient::new(&o.c.env, &o.usdc).mint(&o.c.dao.address, &5_000_000_000);

    let paid = o.c.dao.disburse_aid(&o.c.admin, &recipient, &o.xlm, &o.usdc, &10_000_000_000);

    assert_eq!(paid, 1_200_000_000);
    assert_eq!(TokenClient::new(&o.c.env, &o.usdc).balance(&recipient), 1_200_000_000);
    assert_eq!(TokenClient::new(&o.c.env, &o.usdc).balance(&o.c.dao.address), 3_800_000_000);
}

#[test]
fn disburse_aid_guards_admin_staleness_and_dust() {
    let o = oracle();
    let recipient = Address::generate(&o.c.env);
    StellarAssetClient::new(&o.c.env, &o.usdc).mint(&o.c.dao.address, &5_000_000_000);

    assert_eq!(
        o.c.dao.try_disburse_aid(&recipient, &recipient, &o.xlm, &o.usdc, &10),
        Err(Ok(DaoError::NotAdmin))
    );
    // Rounds to zero: refuse rather than emit an empty payout.
    assert_eq!(
        o.c.dao.try_disburse_aid(&o.c.admin, &recipient, &o.xlm, &o.usdc, &1),
        Err(Ok(DaoError::InvalidAmount))
    );
    o.c.env.ledger().set_timestamp(T0 + MAX_PRICE_AGE_SECS + 1);
    assert_eq!(
        o.c.dao.try_disburse_aid(&o.c.admin, &recipient, &o.xlm, &o.usdc, &10_000_000_000),
        Err(Ok(DaoError::StalePrice))
    );
    assert_eq!(TokenClient::new(&o.c.env, &o.usdc).balance(&recipient), 0);
}
