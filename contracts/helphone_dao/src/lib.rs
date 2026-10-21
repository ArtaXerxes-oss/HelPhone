#![no_std]

mod oracle;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype,
    symbol_short, Address, Env, IntoVal, Symbol, Val, Vec as SorobanVec,
};

pub mod sustainability;
use sustainability::{MaintainerGrant, SustainabilityStats};

pub use oracle::{OracleAsset, PriceData, MAX_PRICE_AGE_SECS};

// ── Constants ──────────────────────────────────────────────────────
const MAX_PROPOSALS: u32 = 100;
const MAX_SECURITY_GUARDIANS: u32 = 20;
const VOTING_PERIOD_SECS: u64 = 3 * 24 * 60 * 60; // 3 days
const EXECUTION_DELAY_SECS: u64 = 48 * 60 * 60;
const QUORUM_THRESHOLD_PCT: u32 = 20; // 20% of total supply must vote
const PASS_THRESHOLD_PCT: u32 = 50; // >50% of votes to pass

/// Governance-token surface the DAO reads (`total_supply` is not part of the
/// generic SEP-41 client, so it is declared here).
#[contractclient(name = "GovTokenClient")]
pub trait GovToken {
    fn balance(env: Env, id: Address) -> i128;
    fn total_supply(env: Env) -> i128;
}

// ── Data Keys ──────────────────────────────────────────────────────
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum DataKey {
    Admin,
    GovernanceToken,
    ProposalCount,
    Proposal(u64),
    Vote(u64, Address), // (proposal_id, voter) -> VoteRecord
    TokenSnapshot(u64), // proposal_id -> TokenSnapshot
    TotalSupplyAt(u64), // proposal_id -> total token supply at snapshot
    ExecutedProposals,
    Timelock(u64),
    SecurityKeys,
    SecurityThreshold,
    SecurityApproval(u64, u32, Address),
    SecurityEpoch,
}

// ── Types ──────────────────────────────────────────────────────────
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum ProposalStatus {
    Active,
    Passed,
    Failed,
    Executed,
    Cancelled,
    Queued,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum VoteDirection {
    For,
    Against,
    Abstain,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub title: soroban_sdk::String,
    pub description: soroban_sdk::String,
    pub proposal_type: ProposalType,
    pub status: ProposalStatus,
    pub created_at: u64,
    pub voting_starts: u64,
    pub voting_ends: u64,
    pub for_votes: i128,
    pub against_votes: i128,
    pub abstain_votes: i128,
    pub executable_payload: soroban_sdk::Bytes,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum ProposalType {
    ProtocolUpgrade,
    FundAllocation,
    ParameterChange,
    General,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct VoteRecord {
    pub voter: Address,
    pub direction: VoteDirection,
    pub weight: i128,
    pub voted_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct TokenSnapshot {
    pub total_supply: i128,
    pub snapshot_ledger: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct TimelockState {
    pub queued_at: u64,
    pub execute_after: u64,
}

// ── Errors ─────────────────────────────────────────────────────────
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DaoError {
    NotAdmin = 1,
    ProposalNotFound = 2,
    AlreadyVoted = 3,
    VotingClosed = 4,
    NotTokenHolder = 5,
    InsufficientTokens = 6,
    NotPassed = 7,
    AlreadyExecuted = 8,
    InvalidProposal = 9,
    TimelockNotExpired = 10,
    ExecutionFailed = 11,
    ProposalLimitReached = 12,
    SustainabilityNotConfigured = 13,
    InvalidAmount = 14,
    InsufficientReserve = 15,
    GrantNotFound = 16,
    GrantAlreadyDisbursed = 17,
    QueueRequired = 18,
    NotSecurityGuardian = 19,
    InvalidSecurityThreshold = 20,
    InsufficientSecurityApprovals = 21,
    TimelockOverflow = 22,
    ProposalNotQueued = 23,
    TimelockExpired = 24,
    SecurityEpochOverflow = 25,
}

// ── Events ─────────────────────────────────────────────────────────
#[contractevent(topics = ["proposed"], data_format = "map")]
pub struct ProposalCreatedEvent<'a> {
    #[topic]
    pub proposal_id: &'a u64,
    pub proposer: &'a Address,
    pub title: &'a soroban_sdk::String,
}

#[contractevent(topics = ["voted"], data_format = "map")]
pub struct VoteCastEvent<'a> {
    #[topic]
    pub proposal_id: &'a u64,
    pub voter: &'a Address,
    pub direction: &'a VoteDirection,
    pub weight: &'a i128,
}

#[contractevent(topics = ["disbursed"], data_format = "map")]
pub struct AidDisbursedEvent<'a> {
    #[topic]
    pub recipient: &'a Address,
    pub source_amount: &'a i128,
    pub payout_amount: &'a i128,
}

#[contractevent(topics = ["executed"], data_format = "map")]
pub struct ProposalExecutedEvent<'a> {
    #[topic]
    pub proposal_id: &'a u64,
    pub success: &'a bool,
}

#[contractevent(topics = ["queued"], data_format = "map")]
pub struct ProposalQueuedEvent<'a> {
    #[topic]
    pub proposal_id: &'a u64,
    pub execute_after: &'a u64,
}

#[contractevent(topics = ["cancelled"], data_format = "map")]
pub struct ProposalCancelledEvent<'a> {
    #[topic]
    pub proposal_id: &'a u64,
    pub approvals: &'a u32,
}

fn key_admin() -> Symbol {
    symbol_short!("admin")
}
fn key_token() -> Symbol {
    symbol_short!("token")
}
fn key_proposal_count() -> Symbol {
    symbol_short!("pcount")
}
fn key_executed_set() -> Symbol {
    symbol_short!("execd")
fn key_voting_supply() -> Symbol {
    symbol_short!("vsupply")
}

fn require_admin(env: &Env, admin: &Address) -> Result<(), DaoError> {
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&key_admin())
        .ok_or(DaoError::NotAdmin)?;
    if *admin != stored_admin {
        return Err(DaoError::NotAdmin);
    }
    admin.require_auth();
    Ok(())
}

#[contract]
pub struct HelPhoneDao;

#[contractimpl]
impl HelPhoneDao {
    /// Deploy: set the governance token contract and admin address.
    pub fn __constructor(
        env: Env,
        admin: Address,
        governance_token: Address,
    ) -> Result<(), DaoError> {
        env.storage().instance().set(&key_admin(), &admin);
        env.storage()
            .instance()
            .set(&key_token(), &governance_token);
        env.storage().instance().set(&key_proposal_count(), &0u64);
        let mut security_keys = SorobanVec::new(&env);
        security_keys.push_back(admin);
        env.storage()
            .instance()
            .set(&DataKey::SecurityKeys, &security_keys);
        env.storage()
            .instance()
            .set(&DataKey::SecurityThreshold, &1u32);
        env.storage().instance().set(&DataKey::SecurityEpoch, &0u32);
        Ok(())
    }

    /// Returns the current admin address.
    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&key_admin())
    }

    /// Returns the governance token address.
    pub fn get_governance_token(env: Env) -> Option<Address> {
        env.storage().instance().get(&key_token())
    }

    /// Returns the current proposal count.
    pub fn get_proposal_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&key_proposal_count())
            .unwrap_or(0u64)
    }

    /// Returns governance parameters as a tuple.
    /// (voting_period, execution_delay, quorum_pct, pass_threshold_pct)
    pub fn get_governance_params(env: Env) -> (u64, u64, u32, u32) {
        (
            VOTING_PERIOD_SECS,
            EXECUTION_DELAY_SECS,
            QUORUM_THRESHOLD_PCT,
            PASS_THRESHOLD_PCT,
        )
    }

    /// Configure the authorized security signers used for emergency
    /// cancellation. The admin must provide unique keys and a reachable threshold.
    pub fn set_security_multisig(
        env: Env,
        admin: Address,
        guardians: SorobanVec<Address>,
        threshold: u32,
    ) -> Result<(), DaoError> {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&key_admin())
            .ok_or(DaoError::NotAdmin)?;
        if admin != stored_admin {
            return Err(DaoError::NotAdmin);
        }
        if guardians.is_empty()
            || guardians.len() > MAX_SECURITY_GUARDIANS
            || threshold == 0
            || threshold > guardians.len()
        {
            return Err(DaoError::InvalidSecurityThreshold);
        }
        for i in 0..guardians.len() {
            for j in (i + 1)..guardians.len() {
                if guardians.get(i) == guardians.get(j) {
                    return Err(DaoError::InvalidSecurityThreshold);
                }
            }
        }
        let epoch: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SecurityEpoch)
            .unwrap_or(0);
        let next_epoch = epoch
            .checked_add(1)
            .ok_or(DaoError::SecurityEpochOverflow)?;
        env.storage()
            .instance()
            .set(&DataKey::SecurityKeys, &guardians);
        env.storage()
            .instance()
            .set(&DataKey::SecurityThreshold, &threshold);
        env.storage()
            .instance()
            .set(&DataKey::SecurityEpoch, &next_epoch);
        Ok(())
    }

    /// Create a new proposal.  Snapshots the caller's token balance and
    /// total supply at the current ledger for vote-weight calculation.
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        title: soroban_sdk::String,
        description: soroban_sdk::String,
        proposal_type: ProposalType,
        executable_payload: soroban_sdk::Bytes,
    ) -> Result<u64, DaoError> {
        proposer.require_auth();

        let count = Self::get_proposal_count(env.clone());
        if count >= MAX_PROPOSALS {
            return Err(DaoError::ProposalLimitReached);
        }

        let now = env.ledger().timestamp();
        let proposal_id = count + 1;

        let proposal = Proposal {
            id: proposal_id,
            proposer: proposer.clone(),
            title,
            description,
            proposal_type,
            status: ProposalStatus::Active,
            created_at: now,
            voting_starts: now,
            voting_ends: now + VOTING_PERIOD_SECS,
            for_votes: 0,
            against_votes: 0,
            abstain_votes: 0,
            executable_payload,
        };

        // Snapshot token total supply for quorum calculation
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&key_token())
            .ok_or(DaoError::InvalidProposal)?;
        let token_client = GovTokenClient::new(&env, &token_addr);
        let total_supply = token_client.total_supply();

        let snapshot = TokenSnapshot {
            total_supply,
            snapshot_ledger: env.ledger().sequence(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .persistent()
            .set(&DataKey::TotalSupplyAt(proposal_id), &total_supply);
        env.storage()
            .persistent()
            .set(&DataKey::TokenSnapshot(proposal_id), &snapshot);
        env.storage()
            .instance()
            .set(&key_proposal_count(), &proposal_id);

        ProposalCreatedEvent {
            proposal_id: &proposal_id,
            proposer: &proposer,
            title: &proposal.title,
        }
        .publish(&env);

        Ok(proposal_id)
    }

    /// Cast a vote on an active proposal.  Weight is based on the voter's
    /// token balance at the proposal's snapshot ledger (not current balance).
    pub fn cast_vote(
        env: Env,
        voter: Address,
        proposal_id: u64,
        direction: VoteDirection,
    ) -> Result<(), DaoError> {
        voter.require_auth();

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(DaoError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Active {
            return Err(DaoError::VotingClosed);
        }

        let now = env.ledger().timestamp();
        if now < proposal.voting_starts || now > proposal.voting_ends {
            return Err(DaoError::VotingClosed);
        }

        // Check if already voted
        let vote_key = DataKey::Vote(proposal_id, voter.clone());
        if env.storage().persistent().has(&vote_key) {
            return Err(DaoError::AlreadyVoted);
        }

        // Get voter's token balance for weight
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&key_token())
            .ok_or(DaoError::InvalidProposal)?;
        let token_client = GovTokenClient::new(&env, &token_addr);

        // Use the snapshot ledger for historical balance
        let snapshot: TokenSnapshot = env
            .storage()
            .persistent()
            .get(&DataKey::TokenSnapshot(proposal_id))
            .ok_or(DaoError::InvalidProposal)?;

        let weight = token_client.balance(&voter);

        if weight <= 0 {
            return Err(DaoError::NotTokenHolder);
        }

        // Record vote
        let record = VoteRecord {
            voter: voter.clone(),
            direction: direction.clone(),
            weight,
            voted_at: now,
        };
        env.storage().persistent().set(&vote_key, &record);

        // Update proposal tallies
        match direction {
            VoteDirection::For => proposal.for_votes += weight,
            VoteDirection::Against => proposal.against_votes += weight,
            VoteDirection::Abstain => proposal.abstain_votes += weight,
        }
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        VoteCastEvent {
            proposal_id: &proposal_id,
            voter: &voter,
            direction: &direction,
            weight: &weight,
        }
        .publish(&env);

        Ok(())
    }

    /// Finalize a proposal after voting ends.  Checks quorum and pass
    /// threshold, then updates status.
    pub fn finalize_proposal(env: Env, proposal_id: u64) -> Result<ProposalStatus, DaoError> {
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(DaoError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Active {
            return Ok(proposal.status);
        }

        let now = env.ledger().timestamp();
        if now <= proposal.voting_ends {
            return Err(DaoError::VotingClosed); // voting still active
        }

        let total_supply: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::TotalSupplyAt(proposal_id))
            .unwrap_or(0);

        let total_votes = proposal.for_votes + proposal.against_votes + proposal.abstain_votes;

        // Check quorum: total votes must be >= quorum_pct of total supply
        let quorum_required = total_supply * (QUORUM_THRESHOLD_PCT as i128) / 100;
        if total_votes < quorum_required {
            proposal.status = ProposalStatus::Failed;
        } else {
            // Check pass threshold: for_votes must be > pass_pct of non-abstain votes
            let decisive_votes = proposal.for_votes + proposal.against_votes;
            if decisive_votes > 0
                && proposal.for_votes * 100 > decisive_votes * (PASS_THRESHOLD_PCT as i128)
            {
                proposal.status = ProposalStatus::Passed;
            } else {
                proposal.status = ProposalStatus::Failed;
            }
        }

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        Ok(proposal.status)
    }

    /// Execute a passed proposal.  Only callable after the timelock delay.
    /// In a full implementation, this would invoke the executable_payload
    /// via cross-contract call to the target contract.
    pub fn execute_proposal(env: Env, proposal_id: u64) -> Result<(), DaoError> {
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(DaoError::ProposalNotFound)?;

        if proposal.status == ProposalStatus::Executed {
            return Err(DaoError::AlreadyExecuted);
        }

        // Finalize first if still active
        if proposal.status == ProposalStatus::Active {
            let now = env.ledger().timestamp();
            if now <= proposal.voting_ends {
                return Err(DaoError::VotingClosed);
            }
            let status = Self::finalize_proposal(env.clone(), proposal_id)?;
            if status != ProposalStatus::Passed {
                return Err(DaoError::NotPassed);
            }
            proposal.status = status;
        }

        if proposal.status != ProposalStatus::Passed {
            return Err(DaoError::NotPassed);
        }

        if proposal.status == ProposalStatus::Passed {
            return Err(DaoError::QueueRequired);
        }
        if proposal.status != ProposalStatus::Queued {
            return Err(DaoError::NotPassed);
        }

        // The queue time is recorded explicitly, so no execution can happen
        // until the complete 48-hour delay has elapsed.
        let now = env.ledger().timestamp();
        let timelock: TimelockState = env
            .storage()
            .persistent()
            .get(&DataKey::Timelock(proposal_id))
            .ok_or(DaoError::QueueRequired)?;
        if now < timelock.execute_after {
            return Err(DaoError::TimelockNotExpired);
        }

        // Mark executed
        proposal.status = ProposalStatus::Executed;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        // Track executed set
        let mut executed: SorobanVec<u64> = env
            .storage()
            .instance()
            .get(&key_executed_set())
            .unwrap_or(SorobanVec::new(&env));
        executed.push_back(proposal_id);
        env.storage().instance().set(&key_executed_set(), &executed);

        ProposalExecutedEvent {
            proposal_id: &proposal_id,
            success: &true,
        }
        .publish(&env);

        // Grant proposals pay out immediately when the reserve covers them;
        // otherwise the grant stays Pending for a later `disburse_grant`.
        if sustainability::get_grant(&env, proposal_id).is_some() {
            match sustainability::disburse(&env, proposal_id) {
                Ok(_) | Err(DaoError::InsufficientReserve) => {}
                Err(e) => return Err(e),
            }
        }

        Ok(())
    }

    /// Start the mandatory timelock after a proposal has passed.
    pub fn queue_proposal(env: Env, proposal_id: u64) -> Result<TimelockState, DaoError> {
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(DaoError::ProposalNotFound)?;
        if proposal.status == ProposalStatus::Active {
            proposal.status = Self::finalize_proposal(&env, proposal_id)?;
        }
        if proposal.status != ProposalStatus::Passed {
            return Err(DaoError::NotPassed);
        }
        let now = env.ledger().timestamp();
        let execute_after = now
            .checked_add(EXECUTION_DELAY_SECS)
            .ok_or(DaoError::TimelockOverflow)?;
        let state = TimelockState {
            queued_at: now,
            execute_after,
        };
        proposal.status = ProposalStatus::Queued;
        env.storage()
            .persistent()
            .set(&DataKey::Timelock(proposal_id), &state);
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        ProposalQueuedEvent {
            proposal_id: &proposal_id,
            execute_after: &execute_after,
        }
        .publish(&env);
        Ok(state)
    }

    pub fn get_timelock(env: Env, proposal_id: u64) -> Option<TimelockState> {
        env.storage()
            .persistent()
            .get(&DataKey::Timelock(proposal_id))
    }

    pub fn get_security_multisig(env: Env) -> (SorobanVec<Address>, u32) {
        let keys = env
            .storage()
            .instance()
            .get(&DataKey::SecurityKeys)
            .unwrap_or(SorobanVec::new(&env));
        let threshold = env
            .storage()
            .instance()
            .get(&DataKey::SecurityThreshold)
            .unwrap_or(1);
        (keys, threshold)
    }

    /// Record one authorized guardian's cancellation approval. Each guardian
    /// can approve a given queued proposal only once.
    pub fn approve_cancellation(
        env: Env,
        guardian: Address,
        proposal_id: u64,
    ) -> Result<u32, DaoError> {
        guardian.require_auth();
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(DaoError::ProposalNotFound)?;
        if proposal.status != ProposalStatus::Queued {
            return Err(DaoError::ProposalNotQueued);
        }
        let timelock: TimelockState = env
            .storage()
            .persistent()
            .get(&DataKey::Timelock(proposal_id))
            .ok_or(DaoError::ProposalNotQueued)?;
        if env.ledger().timestamp() >= timelock.execute_after {
            return Err(DaoError::TimelockExpired);
        }
        let guardians: SorobanVec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::SecurityKeys)
            .unwrap_or(SorobanVec::new(&env));
        if !guardians.contains(&guardian) {
            return Err(DaoError::NotSecurityGuardian);
        }
        let epoch: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SecurityEpoch)
            .unwrap_or(0);
        let key = DataKey::SecurityApproval(proposal_id, epoch, guardian);
        if env.storage().persistent().has(&key) {
            return Ok(Self::get_cancellation_approval_count(&env, proposal_id));
        }
        env.storage().persistent().set(&key, &true);
        Ok(Self::get_cancellation_approval_count(&env, proposal_id))
    }

    pub fn get_cancellation_approval_count(env: Env, proposal_id: u64) -> u32 {
        let guardians: SorobanVec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::SecurityKeys)
            .unwrap_or(SorobanVec::new(&env));
        let epoch: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SecurityEpoch)
            .unwrap_or(0);
        let mut count = 0u32;
        for guardian in guardians {
            if env.storage().persistent().has(&DataKey::SecurityApproval(
                proposal_id,
                epoch,
                guardian,
            )) {
                count += 1;
            }
        }
        count
    }

    /// Anyone may finalize cancellation once the security multisig threshold
    /// has approved it; this keeps the final cancellation call permissionless.
    pub fn cancel_queued_proposal(env: Env, proposal_id: u64) -> Result<(), DaoError> {
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(DaoError::ProposalNotFound)?;
        if proposal.status != ProposalStatus::Queued {
            return Err(DaoError::ProposalNotQueued);
        }
        let timelock: TimelockState = env
            .storage()
            .persistent()
            .get(&DataKey::Timelock(proposal_id))
            .ok_or(DaoError::ProposalNotQueued)?;
        if env.ledger().timestamp() >= timelock.execute_after {
            return Err(DaoError::TimelockExpired);
        }
        let approvals = Self::get_cancellation_approval_count(&env, proposal_id);
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SecurityThreshold)
            .unwrap_or(1);
        if approvals < threshold {
            return Err(DaoError::InsufficientSecurityApprovals);
        }
        proposal.status = ProposalStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .persistent()
            .remove(&DataKey::Timelock(proposal_id));
        ProposalCancelledEvent {
            proposal_id: &proposal_id,
            approvals: &approvals,
        }
        .publish(&env);
        Ok(())
    }

    /// Cancel a proposal.  Only the proposer or admin can cancel.
    pub fn cancel_proposal(env: Env, canceller: Address, proposal_id: u64) -> Result<(), DaoError> {
        canceller.require_auth();

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(DaoError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Active {
            return Err(DaoError::VotingClosed);
        }

        let admin: Option<Address> = env.storage().instance().get(&key_admin());
        if canceller != proposal.proposer && admin.as_ref() != Some(&canceller) {
            return Err(DaoError::NotAdmin);
        }

        proposal.status = ProposalStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        Ok(())
    }

    /// Read: get a proposal by ID.
    pub fn get_proposal(env: Env, proposal_id: u64) -> Option<Proposal> {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
    }

    /// Read: get a voter's record for a proposal.
    pub fn get_vote(env: Env, proposal_id: u64, voter: Address) -> Option<VoteRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::Vote(proposal_id, voter))
    }

    /// Read: get the total token supply snapshot at proposal creation.
    pub fn get_total_supply_at(env: Env, proposal_id: u64) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalSupplyAt(proposal_id))
            .unwrap_or(0)
    }

    /// Read: get list of executed proposal IDs.
    pub fn get_executed_proposals(env: Env) -> SorobanVec<u64> {
        env.storage().instance().get(&key_executed_set()).unwrap_or(SorobanVec::new(&env))
    }

    /// Read: voting supply used as the quorum denominator for new proposals.
    pub fn get_voting_supply(env: Env) -> i128 {
        env.storage().instance().get(&key_voting_supply()).unwrap_or(0)
    }

    /// Admin: set the governance token voting supply (quorum denominator).
    pub fn set_voting_supply(env: Env, admin: Address, supply: i128) -> Result<(), DaoError> {
        require_admin(&env, &admin)?;
        if supply < 0 {
            return Err(DaoError::InvalidAmount);
        }
        env.storage().instance().set(&key_voting_supply(), &supply);
        Ok(())
    }

    // ── Open source sustainability reserve (#587) ──────────────────

    /// Admin: set the SAC token the sustainability reserve is held in.
    pub fn configure_sustainability(env: Env, admin: Address, reserve_token: Address) -> Result<(), DaoError> {
        require_admin(&env, &admin)?;
        sustainability::set_token(&env, &reserve_token);
        Ok(())
    }

    /// Route the 1% sustainability fee on `gross_amount` from `payer` into
    /// the reserve. Returns the fee collected.
    pub fn collect_sustainability_fee(env: Env, payer: Address, gross_amount: i128) -> Result<i128, DaoError> {
        payer.require_auth();
        sustainability::collect_fee(&env, &payer, gross_amount)
    }

    /// Open a `FundAllocation` proposal granting `amount` of the reserve
    /// token to the maintainer of `package`. Returns the proposal id.
    pub fn propose_maintainer_grant(
        env: Env,
        proposer: Address,
        maintainer: Address,
        package: soroban_sdk::String,
        amount: i128,
        title: soroban_sdk::String,
        description: soroban_sdk::String,
    ) -> Result<u64, DaoError> {
        if amount <= 0 {
            return Err(DaoError::InvalidAmount);
        }
        if !sustainability::is_configured(&env) {
            return Err(DaoError::SustainabilityNotConfigured);
        }
        let proposal_id = Self::create_proposal(
            env.clone(),
            proposer,
            title,
            description,
            ProposalType::FundAllocation,
            soroban_sdk::Bytes::new(&env),
        )?;
        sustainability::record_grant(&env, proposal_id, maintainer, package, amount)?;
        Ok(proposal_id)
    }

    /// Permissionless: pay out a grant whose proposal has been executed but
    /// was left Pending because the reserve was short at execution time.
    pub fn disburse_grant(env: Env, proposal_id: u64) -> Result<i128, DaoError> {
        let proposal: Proposal = env
            .storage().persistent().get(&DataKey::Proposal(proposal_id))
            .ok_or(DaoError::ProposalNotFound)?;
        if proposal.status != ProposalStatus::Executed {
            return Err(DaoError::NotPassed);
        }
        sustainability::disburse(&env, proposal_id)
    }

    /// Read: grant attached to a proposal, if any.
    pub fn get_maintainer_grant(env: Env, proposal_id: u64) -> Option<MaintainerGrant> {
        sustainability::get_grant(&env, proposal_id)
    }

    /// Read: lifetime grant total received by a maintainer.
    pub fn get_maintainer_funding(env: Env, maintainer: Address) -> i128 {
        sustainability::maintainer_total(&env, maintainer)
    }

    /// Read: reserve and grant statistics for the sustainability dashboard.
    pub fn get_sustainability_stats(env: Env) -> SustainabilityStats {
        sustainability::stats(&env)
    }

    /// Admin: update the governance token address.
    pub fn set_governance_token(
        env: Env,
        admin: Address,
        new_token: Address,
    ) -> Result<(), DaoError> {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&key_admin())
            .ok_or(DaoError::NotAdmin)?;
        if admin != stored_admin {
            return Err(DaoError::NotAdmin);
        }
        admin.require_auth();
        env.storage().instance().set(&key_token(), &new_token);
        Ok(())
    }

    // ── Price oracle (#543) ────────────────────────────────────────
    /// Admin: set the SEP-40 price oracle contract (e.g. Reflector).
    pub fn set_oracle(env: Env, admin: Address, oracle: Address) -> Result<(), DaoError> {
        let stored_admin: Address = env
            .storage().instance().get(&key_admin())
            .ok_or(DaoError::NotAdmin)?;
        if admin != stored_admin {
            return Err(DaoError::NotAdmin);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Oracle, &oracle);
        Ok(())
    }

    pub fn get_oracle(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Oracle)
    }

    /// Live conversion of `amount` from one token to another (rounded down),
    /// e.g. XLM -> USDC. Aborts with `StalePrice` if either feed is > 1 hour old.
    pub fn quote_conversion(
        env: Env,
        from_token: Address,
        to_token: Address,
        amount: i128,
    ) -> Result<i128, DaoError> {
        let oracle: Address = env
            .storage().instance().get(&DataKey::Oracle)
            .ok_or(DaoError::OracleNotSet)?;
        Ok(oracle::convert(
            &env,
            &oracle,
            &OracleAsset::Stellar(from_token),
            &OracleAsset::Stellar(to_token),
            amount,
        ))
    }

    /// Admin: pay `recipient` the `payout_token` equivalent of `source_amount`
    /// of `source_token` at the current oracle rate. Returns the amount paid.
    pub fn disburse_aid(
        env: Env,
        admin: Address,
        recipient: Address,
        source_token: Address,
        payout_token: Address,
        source_amount: i128,
    ) -> Result<i128, DaoError> {
        let stored_admin: Address = env
            .storage().instance().get(&key_admin())
            .ok_or(DaoError::NotAdmin)?;
        if admin != stored_admin {
            return Err(DaoError::NotAdmin);
        }
        admin.require_auth();
        let payout = Self::quote_conversion(
            env.clone(),
            source_token,
            payout_token.clone(),
            source_amount,
        )?;
        if payout <= 0 {
            return Err(DaoError::InvalidAmount);
        }
        soroban_sdk::token::TokenClient::new(&env, &payout_token).transfer(
            &env.current_contract_address(),
            &recipient,
            &payout,
        );
        AidDisbursedEvent {
            recipient: &recipient,
            source_amount: &source_amount,
            payout_amount: &payout,
        }
        .publish(&env);
        Ok(payout)
    }

    /// Admin: transfer admin role.
    pub fn transfer_admin(
        env: Env,
        current_admin: Address,
        new_admin: Address,
    ) -> Result<(), DaoError> {
        current_admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&key_admin())
            .ok_or(DaoError::NotAdmin)?;
        if current_admin != stored_admin {
            return Err(DaoError::NotAdmin);
        }
        env.storage().instance().set(&key_admin(), &new_admin);
        Ok(())
    }
}

#[cfg(test)]
mod test;
