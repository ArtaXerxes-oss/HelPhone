#![no_std]

//! Aegis Vault — ZK-gated aid disbursement with a multi-asset treasury.
//!
//! Campaign funds are held per campaign; every asset the vault touches is also
//! tracked as a treasury reserve (see [`treasury`]) so disbursements can be
//! capped per day and reserves can be rebalanced toward target weights.
//!
//! Zone bounding boxes can additionally be checked against differential-privacy
//! bounds (see [`privacy`], #529); the checks are off until an admin enables them.

mod privacy;
mod treasury;

use privacy::{BoundingBox, PrivacyError, PrivacyParams, TrackedZone, MAX_TRACKED_ZONES};

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, vec, Address, Bytes, BytesN, Env,
    IntoVal, Symbol, Vec,
};

/// 50 tokens at 7 decimals.
pub const DEFAULT_PAYOUT_STROOP: i128 = 500_000_000;
/// Default per-asset daily disbursement cap: 10 default payouts.
pub const DEFAULT_DAILY_LIMIT_STROOP: i128 = 10 * DEFAULT_PAYOUT_STROOP;
/// 5 × 32-byte big-endian public inputs up to and including `campaign_id`.
pub const CAMPAIGN_INPUTS_LEN: usize = 160;
/// 7 × 32-byte big-endian public inputs (…, recipient, nullifier).
pub const PUBLIC_INPUTS_LEN: usize = 224;

#[contracterror]
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VaultError {
    NotAdmin = 1,
    InvalidAmount = 2,
    InvalidPublicInputs = 3,
    AlreadyClaimed = 4,
    VerificationFailed = 5,
    InsufficientFunds = 6,
    NotInitialized = 7,
    Overflow = 8,
    DailyLimitExceeded = 9,
    UnknownAsset = 10,
    InvalidWeights = 11,
    InvalidPrices = 12,
    // Differential-privacy zone checks (#529). All fire before any token moves.
    InvalidPrivacyParams = 13,
    BoxMalformed = 14,
    BoxNotOnGrid = 15,
    BoxTooSmall = 16,
    ZoneOverlapTooSmall = 17,
    ReentrantCall = 18,
}

#[derive(Clone)]
#[contracttype]
enum DataKey {
    Verifier,
    Token,
    Admin,
    Payout,
    Campaign(BytesN<32>),
    Claimed(BytesN<32>),
    Privacy,
    TrackedZones,
    ReentrancyLock,
}

fn get<T: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(
    env: &Env,
    key: &DataKey,
) -> Result<T, VaultError> {
    env.storage()
        .instance()
        .get(key)
        .ok_or(VaultError::NotInitialized)
}

fn require_admin(env: &Env, admin: &Address) -> Result<(), VaultError> {
    let stored: Address = get(env, &DataKey::Admin)?;
    if *admin != stored {
        return Err(VaultError::NotAdmin);
    }
    admin.require_auth();
    Ok(())
}

fn enter_reentrancy_guard(env: &Env) -> Result<(), VaultError> {
    if env
        .storage()
        .instance()
        .get::<_, bool>(&DataKey::ReentrancyLock)
        .unwrap_or(false)
    {
        return Err(VaultError::ReentrantCall);
    }
    env.storage().instance().set(&DataKey::ReentrancyLock, &true);
    Ok(())
}

fn exit_reentrancy_guard(env: &Env) {
    env.storage().instance().remove(&DataKey::ReentrancyLock);
}

fn with_reentrancy_guard<T>(
    env: &Env,
    f: impl FnOnce() -> Result<T, VaultError>,
) -> Result<T, VaultError> {
    enter_reentrancy_guard(env)?;
    let result = f();
    exit_reentrancy_guard(env);
    result
}

/// Keep tracked zones alive: bump when under ~30 days, to ~90 (5 s ledgers).
const PZONES_TTL_THRESHOLD: u32 = 17_280 * 30;
const PZONES_TTL_EXTEND_TO: u32 = 17_280 * 90;

fn privacy_error(e: PrivacyError) -> VaultError {
    match e {
        PrivacyError::InvalidParams => VaultError::InvalidPrivacyParams,
        PrivacyError::Malformed => VaultError::BoxMalformed,
        PrivacyError::NotOnGrid => VaultError::BoxNotOnGrid,
        PrivacyError::TooSmall => VaultError::BoxTooSmall,
        PrivacyError::OverlapTooSmall => VaultError::ZoneOverlapTooSmall,
    }
}

fn privacy_params(env: &Env) -> PrivacyParams {
    env.storage()
        .instance()
        .get(&DataKey::Privacy)
        .unwrap_or(PrivacyParams::defaults())
}

fn tracked_zones(env: &Env) -> Vec<TrackedZone> {
    env.storage()
        .persistent()
        .get(&DataKey::TrackedZones)
        .unwrap_or(Vec::new(env))
}

/// Validate a zone's box (Laplace bound + grid) and its overlap with every
/// other tracked zone. Read-only. A no-op while privacy checks are disabled.
fn check_zone_privacy(
    env: &Env,
    campaign_id: &BytesN<32>,
    public_inputs_prefix: &Bytes,
) -> Result<Option<BoundingBox>, VaultError> {
    let params = privacy_params(env);
    if !params.enabled {
        return Ok(None);
    }
    if public_inputs_prefix.len() < 128 {
        return Err(VaultError::InvalidPublicInputs);
    }
    let mut buf = [0u8; 128];
    public_inputs_prefix.slice(0..128).copy_into_slice(&mut buf);
    let bbox = privacy::parse_box(&buf).ok_or(VaultError::BoxMalformed)?;
    privacy::validate_box(&params, &bbox).map_err(privacy_error)?;
    for zone in tracked_zones(env).iter() {
        // Re-funding a campaign is not an overlap with itself.
        if zone.campaign_id != *campaign_id {
            privacy::check_overlap(&params, &bbox, &zone.bbox).map_err(privacy_error)?;
        }
    }
    Ok(Some(bbox))
}

/// Remember `bbox` for `campaign_id` so later zones are checked against it.
/// Once `MAX_TRACKED_ZONES` are held, the oldest is forgotten.
fn track_zone(env: &Env, campaign_id: &BytesN<32>, bbox: BoundingBox) {
    let mut zones = tracked_zones(env);
    let mut existing = None;
    for (i, z) in zones.iter().enumerate() {
        if z.campaign_id == *campaign_id {
            existing = Some(i as u32);
            break;
        }
    }
    let entry = TrackedZone { campaign_id: campaign_id.clone(), bbox };
    match existing {
        Some(i) => zones.set(i, entry),
        None => {
            if zones.len() >= MAX_TRACKED_ZONES {
                zones.remove(0);
            }
            zones.push_back(entry);
        }
    }
    env.storage().persistent().set(&DataKey::TrackedZones, &zones);
    env.storage().persistent().extend_ttl(
        &DataKey::TrackedZones,
        PZONES_TTL_THRESHOLD,
        PZONES_TTL_EXTEND_TO,
    );
}

#[contract]
pub struct AegisVault;

#[contractimpl]
impl AegisVault {
    pub fn __constructor(env: Env, verifier: Address, token: Address, admin: Address) {
        let s = env.storage().instance();
        s.set(&DataKey::Verifier, &verifier);
        s.set(&DataKey::Token, &token);
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Payout, &DEFAULT_PAYOUT_STROOP);
        treasury::register_asset(&env, &token);
        treasury::set_daily_limit(&env, &token, DEFAULT_DAILY_LIMIT_STROOP);
    }

    // ── Admin / config ─────────────────────────────────────────────
    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), VaultError> {
        let admin: Address = get(&env, &DataKey::Admin)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    pub fn payout_amount(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::Payout)
            .unwrap_or(DEFAULT_PAYOUT_STROOP)
    }

    pub fn set_payout_amount(env: Env, admin: Address, amount: i128) -> Result<(), VaultError> {
        require_admin(&env, &admin)?;
        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        env.storage().instance().set(&DataKey::Payout, &amount);
        Ok(())
    }

    // ── Differential-privacy zone checks (#529) ────────────────────
    /// Configure the zone checks. Admin only. While `params.enabled` is false
    /// (the default) zones are not checked. Changing parameters never affects
    /// zones that are already funded.
    pub fn set_privacy_params(
        env: Env,
        admin: Address,
        params: PrivacyParams,
    ) -> Result<(), VaultError> {
        require_admin(&env, &admin)?;
        params.validate().map_err(privacy_error)?;
        env.storage().instance().set(&DataKey::Privacy, &params);
        Ok(())
    }

    /// Current privacy parameters (defaults, disabled, until an admin sets them).
    pub fn privacy_params(env: Env) -> PrivacyParams {
        privacy_params(&env)
    }

    /// Smallest allowed zone side, in stored-coordinate units: the Laplace
    /// tail bound `sensitivity / epsilon * tail_mult`, rounded up to the grid.
    /// 0 if the stored parameters are invalid.
    pub fn min_box_dimension(env: Env) -> u64 {
        privacy::min_dimension(&privacy_params(&env)).unwrap_or(0)
    }

    /// Dry-run the zone checks for a 160-byte `public_inputs_prefix` without
    /// funding or registering anything, so a client can preflight a zone.
    pub fn validate_zone(env: Env, public_inputs_prefix: Bytes) -> Result<(), VaultError> {
        if public_inputs_prefix.len() as usize != CAMPAIGN_INPUTS_LEN {
            return Err(VaultError::InvalidPublicInputs);
        }
        let campaign_id: BytesN<32> = public_inputs_prefix.slice(128..160).try_into().unwrap();
        check_zone_privacy(&env, &campaign_id, &public_inputs_prefix)?;
        Ok(())
    }

    // ── Campaigns ──────────────────────────────────────────────────
    pub fn campaign_balance(env: Env, campaign_id: BytesN<32>) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Campaign(campaign_id))
            .unwrap_or(0)
    }

    pub fn is_claimed(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Claimed(nullifier))
    }

    pub fn fund_zone(
        env: Env,
        funder: Address,
        public_inputs_prefix: Bytes,
        amount: i128,
    ) -> Result<(), VaultError> {
        with_reentrancy_guard(&env, || {
            funder.require_auth();
            if amount <= 0 {
                return Err(VaultError::InvalidAmount);
            }
            if public_inputs_prefix.len() as usize != CAMPAIGN_INPUTS_LEN {
                return Err(VaultError::InvalidPublicInputs);
            }
            let campaign_id: BytesN<32> = public_inputs_prefix.slice(128..160).try_into().unwrap();
            // Differential-privacy checks run before any token moves (#529).
            let tracked = check_zone_privacy(&env, &campaign_id, &public_inputs_prefix)?;
            let asset: Address = get(&env, &DataKey::Token)?;
            token::Client::new(&env, &asset).transfer(
                &funder,
                &env.current_contract_address(),
                &amount,
            );
            if let Some(bbox) = tracked {
                track_zone(&env, &campaign_id, bbox);
            }
            let key = DataKey::Campaign(campaign_id);
            let cur: i128 = env.storage().persistent().get(&key).unwrap_or(0);
            let next = cur.checked_add(amount).ok_or(VaultError::Overflow)?;
            env.storage().persistent().set(&key, &next);
            treasury::credit(&env, &asset, amount)
        })
    }

    pub fn claim_aid(
        env: Env,
        recipient: Address,
        public_inputs: Bytes,
        proof_bytes: Bytes,
    ) -> Result<(), VaultError> {
        with_reentrancy_guard(&env, || {
            recipient.require_auth();
            if public_inputs.len() as usize != PUBLIC_INPUTS_LEN {
                return Err(VaultError::InvalidPublicInputs);
            }
            let nullifier: BytesN<32> = public_inputs.slice(192..224).try_into().unwrap();
            let campaign_id: BytesN<32> = public_inputs.slice(128..160).try_into().unwrap();

            let claimed_key = DataKey::Claimed(nullifier);
            if env.storage().persistent().has(&claimed_key) {
                return Err(VaultError::AlreadyClaimed);
            }

            let verifier: Address = get(&env, &DataKey::Verifier)?;
            let ok: bool = env.invoke_contract(
                &verifier,
                &Symbol::new(&env, "verify_proof"),
                vec![&env, public_inputs.into_val(&env), proof_bytes.into_val(&env)],
            );
            if !ok {
                return Err(VaultError::VerificationFailed);
            }

            let payout = Self::payout_amount(env.clone());
            let asset: Address = get(&env, &DataKey::Token)?;
            let campaign_key = DataKey::Campaign(campaign_id);
            let balance: i128 = env.storage().persistent().get(&campaign_key).unwrap_or(0);
            if balance < payout {
                return Err(VaultError::InsufficientFunds);
            }

            // Daily cap first: a rejected claim leaves nullifier + balances untouched.
            treasury::debit_disbursement(&env, &asset, payout)?;
            env.storage().persistent().set(&campaign_key, &(balance - payout));
            env.storage().persistent().set(&claimed_key, &true);
            token::Client::new(&env, &asset).transfer(
                &env.current_contract_address(),
                &recipient,
                &payout,
            );
            Ok(())
        })
    }

    // ── Treasury (multi-asset reserves) ────────────────────────────
    pub fn treasury_assets(env: Env) -> Vec<Address> {
        treasury::assets(&env)
    }

    pub fn treasury_reserve(env: Env, asset: Address) -> i128 {
        treasury::reserve(&env, &asset)
    }

    /// Adds an asset to the treasury so it can hold reserves.
    pub fn add_treasury_asset(env: Env, admin: Address, asset: Address) -> Result<(), VaultError> {
        require_admin(&env, &admin)?;
        treasury::register_asset(&env, &asset);
        Ok(())
    }

    /// Pulls `amount` of a registered asset from `from` into the treasury reserve.
    pub fn treasury_deposit(
        env: Env,
        from: Address,
        asset: Address,
        amount: i128,
    ) -> Result<(), VaultError> {
        with_reentrancy_guard(&env, || {
            from.require_auth();
            if amount <= 0 {
                return Err(VaultError::InvalidAmount);
            }
            if !treasury::is_registered(&env, &asset) {
                return Err(VaultError::UnknownAsset);
            }
            token::Client::new(&env, &asset).transfer(&from, &env.current_contract_address(), &amount);
            treasury::credit(&env, &asset, amount)
        })
    }

    /// Admin withdrawal from the treasury; counts against the daily cap.
    pub fn treasury_withdraw(
        env: Env,
        admin: Address,
        asset: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), VaultError> {
        with_reentrancy_guard(&env, || {
            require_admin(&env, &admin)?;
            if amount <= 0 {
                return Err(VaultError::InvalidAmount);
            }
            treasury::debit_disbursement(&env, &asset, amount)?;
            token::Client::new(&env, &asset).transfer(&env.current_contract_address(), &to, &amount);
            Ok(())
        })
    }

    /// Sets the max amount of `asset` that may leave the vault per UTC day.
    pub fn set_daily_limit(
        env: Env,
        admin: Address,
        asset: Address,
        limit: i128,
    ) -> Result<(), VaultError> {
        require_admin(&env, &admin)?;
        if limit <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        if !treasury::is_registered(&env, &asset) {
            return Err(VaultError::UnknownAsset);
        }
        treasury::set_daily_limit(&env, &asset, limit);
        Ok(())
    }

    pub fn daily_limit(env: Env, asset: Address) -> i128 {
        treasury::daily_limit(&env, &asset)
    }

    pub fn spent_today(env: Env, asset: Address) -> i128 {
        treasury::spent_today(&env, &asset)
    }

    pub fn remaining_today(env: Env, asset: Address) -> i128 {
        treasury::remaining_today(&env, &asset)
    }

    /// Sets target reserve weights in basis points (sum must be ≤ 10_000).
    pub fn set_target_weights(
        env: Env,
        admin: Address,
        assets: Vec<Address>,
        weights_bps: Vec<u32>,
    ) -> Result<(), VaultError> {
        require_admin(&env, &admin)?;
        treasury::set_target_weights(&env, assets, weights_bps)
    }

    pub fn target_weight(env: Env, asset: Address) -> u32 {
        treasury::target_weight(&env, &asset)
    }

    /// Read-only rebalance plan. `prices` are per-asset prices (same order as
    /// `treasury_assets`) in a common quote unit; returns, per asset, the signed
    /// amount (asset units) to buy (+) or sell (−) to reach its target weight.
    /// Swaps are executed off-chain / by a DEX adapter; the vault never trades.
    pub fn rebalance_plan(env: Env, prices: Vec<i128>) -> Result<Vec<i128>, VaultError> {
        treasury::rebalance_plan(&env, prices)
    }
}

#[cfg(test)]
mod test;
