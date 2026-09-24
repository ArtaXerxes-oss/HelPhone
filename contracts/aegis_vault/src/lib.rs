#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, symbol_short,
    token, Address, Bytes, BytesN, Env, InvokeError, IntoVal, Symbol, Val,
    Vec as SorobanVec,
    xdr::ToXdr,
};

// ── Public inputs layout (224 bytes = 7 x 32) ───────────────────────────────
// [  0.. 32] box_x_min       encoded longitude lower bound (u64 as 32-byte BE)
// [ 32.. 64] box_x_max       encoded longitude upper bound
// [ 64.. 96] box_y_min       encoded latitude  lower bound
// [ 96..128] box_y_max       encoded latitude  upper bound
// [128..160] campaign_id     zone identifier   (Field as 32-byte BE)
// [160..192] recipient_address  Stellar pubkey padded to Field
// [192..224] nullifier       Poseidon2(secret_id, campaign_id) — proof return value
const CAMPAIGN_INPUTS_LEN: usize = 160;
const PUBLIC_INPUTS_LEN: usize = 224;
/// Keep attacker-controlled proof material far below the host linear-memory ceiling.
const MAX_PROOF_BYTES: u32 = 1024 * 1024;
const DEFAULT_PAYOUT_STROOP: i128 = 50 * 10_000_000; // 50 USDC (7 decimals)
const BN254_FIELD_PRIME: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d,
    0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

#[contract]
pub struct AegisVault;

#[contracterror]
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum VaultError {
    AlreadyClaimed = 1,   // nullifier already in storage
    VerificationFailed = 2,
    InsufficientFunds = 3,
    InvalidPublicInputs = 4,
    VerifierNotSet = 5,
    TokenNotSet = 6,
    RecipientMismatch = 7,
    Overflow = 8,
    NotAuthorized = 9,
    InvalidPayout = 10,
    // AdminNotSet(11): upgrade()'s admin-unset guard; distinct from
    // NotAuthorized since it fires before there's anyone to check auth
    // against. The old `Unauthorized` variant this branch briefly had
    // was dead code — upgrade() relies on admin.require_auth() trapping,
    // it never returned that error — so it's dropped in favor of the
    // NotAuthorized variant set_payout_amount() already uses for the
    // same "caller isn't admin" case.
    AdminNotSet = 11,
    PayloadTooLarge = 12,
}

#[contractevent(topics = ["claimed"], data_format = "map")]
pub struct ClaimedEvent<'a> {
    #[topic]
    pub campaign_id: &'a BytesN<32>,
    pub nullifier: &'a BytesN<32>,
    pub recipient: &'a Address,
}

#[contractevent(topics = ["funded"], data_format = "map")]
pub struct FundedEvent<'a> {
    #[topic]
    pub campaign_id: &'a BytesN<32>,
    pub amount: &'a i128,
    pub funder: &'a Address,
}

fn key_verifier()  -> Symbol { symbol_short!("verifier") }
fn key_token()     -> Symbol { symbol_short!("token") }
fn key_admin()     -> Symbol { symbol_short!("admin") }
fn key_payout()    -> Symbol { symbol_short!("payout") }
fn key_nullifier_prefix() -> Symbol { symbol_short!("nf") }
fn key_campaign_prefix()  -> Symbol { symbol_short!("camp") }
fn key_zone_prefix()      -> Symbol { symbol_short!("zone") }

fn payout_amount(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&key_payout())
        .unwrap_or(DEFAULT_PAYOUT_STROOP)
}

fn parse_public_inputs(
    env: &Env,
    public_inputs: &Bytes,
) -> Result<(Bytes, BytesN<32>, BytesN<32>, BytesN<32>), VaultError> {
    if public_inputs.len() as usize != PUBLIC_INPUTS_LEN {
        return Err(VaultError::InvalidPublicInputs);
    }
    let mut buf = [0u8; PUBLIC_INPUTS_LEN];
    public_inputs.copy_into_slice(&mut buf);

    let mut campaign_id = [0u8; 32];
    campaign_id.copy_from_slice(&buf[128..160]);
    let mut recipient_field = [0u8; 32];
    recipient_field.copy_from_slice(&buf[160..192]);
    let mut nullifier = [0u8; 32];
    nullifier.copy_from_slice(&buf[192..224]);

    let public_inputs_prefix = Bytes::from_slice(env, &buf[0..CAMPAIGN_INPUTS_LEN]);

    Ok((
        public_inputs_prefix,
        BytesN::from_array(env, &campaign_id),
        BytesN::from_array(env, &recipient_field),
        BytesN::from_array(env, &nullifier),
    ))
}

fn address_to_field_bytes(env: &Env, recipient: &Address) -> BytesN<32> {
    let serialized = recipient.to_xdr(env);
    let mut bytes = [0u8; 32];
    let len = serialized.len() as usize;
    if len >= 32 {
        let start = len - 32;
        for i in 0..32 {
            bytes[i] = serialized.get((start + i) as u32).unwrap();
        }
    }
    reduce_mod_bn254(&mut bytes);
    BytesN::from_array(env, &bytes)
}

fn cmp_be(a: &[u8; 32], b: &[u8; 32]) -> i32 {
    for i in 0..32 {
        if a[i] > b[i] {
            return 1;
        }
        if a[i] < b[i] {
            return -1;
        }
    }
    0
}

fn sub_be(a: &mut [u8; 32], b: &[u8; 32]) {
    let mut borrow = 0u16;
    for i in (0..32).rev() {
        let av = a[i] as u16;
        let bv = b[i] as u16 + borrow;
        if av >= bv {
            a[i] = (av - bv) as u8;
            borrow = 0;
        } else {
            a[i] = ((av + 256) - bv) as u8;
            borrow = 1;
        }
    }
}

fn reduce_mod_bn254(bytes: &mut [u8; 32]) {
    while cmp_be(bytes, &BN254_FIELD_PRIME) >= 0 {
        sub_be(bytes, &BN254_FIELD_PRIME);
    }
}

fn call_verify_proof(
    env: &Env,
    verifier: &Address,
    public_inputs: Bytes,
    proof_bytes: Bytes,
) -> Result<(), VaultError> {
    let mut args: SorobanVec<Val> = SorobanVec::new(env);
    args.push_back(public_inputs.into_val(env));
    args.push_back(proof_bytes.into_val(env));
    env.try_invoke_contract::<(), InvokeError>(verifier, &Symbol::new(env, "verify_proof"), args)
        .map_err(|_| VaultError::VerificationFailed)?
        .map_err(|_| VaultError::VerificationFailed)
}

#[contractimpl]
impl AegisVault {
    /// Deploy: set verifier contract address, reward token, and the admin
    /// authorized to perform future upgrades (issue #176).
    pub fn __constructor(
        env: Env,
        verifier: Address,
        token: Address,
        admin: Address,
    ) -> Result<(), VaultError> {
        env.storage().instance().set(&key_verifier(), &verifier);
        env.storage().instance().set(&key_token(), &token);
        env.storage().instance().set(&key_admin(), &admin);
        env.storage().instance().set(&key_payout(), &DEFAULT_PAYOUT_STROOP);
        Ok(())
    }

    /// Upgrade the contract's executable WASM to `new_wasm_hash`. Only the
    /// admin set at deploy time may call this. Soroban's upgrade model
    /// swaps the code while preserving existing instance/persistent
    /// storage, so campaign balances and spent nullifiers survive the
    /// upgrade untouched — no state migration needed.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), VaultError> {
        let admin: Address = env
            .storage().instance().get(&key_admin())
            .ok_or(VaultError::AdminNotSet)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Returns the current admin address, if set.
    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&key_admin())
    }

    /// Update the aid payout amount in token base units. Admin authorization is required.
    pub fn set_payout_amount(
        env: Env,
        admin: Address,
        amount: i128,
    ) -> Result<(), VaultError> {
        if amount <= 0 {
            return Err(VaultError::InvalidPayout);
        }
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&key_admin())
            .ok_or(VaultError::NotAuthorized)?;
        if admin != stored_admin {
            return Err(VaultError::NotAuthorized);
        }
        admin.require_auth();
        env.storage().instance().set(&key_payout(), &amount);
        Ok(())
    }

    /// Returns the current aid payout amount in token base units.
    pub fn payout_amount(env: Env) -> i128 {
        payout_amount(&env)
    }

    /// Fund a campaign zone. Transfers `amount` USDC from funder to this contract.
    /// `public_inputs_prefix` is 160 bytes:
    /// box_x_min | box_x_max | box_y_min | box_y_max | campaign_id.
    /// Claims must use exactly this zone prefix.
    pub fn fund_zone(
        env: Env,
        funder: Address,
        public_inputs_prefix: Bytes,
        amount: i128,
    ) -> Result<(), VaultError> {
        if public_inputs_prefix.len() as usize != CAMPAIGN_INPUTS_LEN {
            return Err(VaultError::InvalidPublicInputs);
        }
        funder.require_auth();

        let mut buf = [0u8; CAMPAIGN_INPUTS_LEN];
        public_inputs_prefix.copy_into_slice(&mut buf);
        let mut campaign_id_bytes = [0u8; 32];
        campaign_id_bytes.copy_from_slice(&buf[128..160]);
        let campaign_id = BytesN::from_array(&env, &campaign_id_bytes);

        let token_addr: Address = env
            .storage().instance().get(&key_token())
            .ok_or(VaultError::TokenNotSet)?;

        // Pull tokens from funder into this contract.
        let token_client = token::TokenClient::new(&env, &token_addr);
        token_client.transfer(&funder, &env.current_contract_address(), &amount);

        // Update campaign balance safely.
        if amount <= 0 {
            return Err(VaultError::InvalidPublicInputs);
        }
        let camp_key = (key_campaign_prefix(), campaign_id.clone());
        let current: i128 = env.storage().instance().get(&camp_key).unwrap_or(0i128);
        let new_balance = current.checked_add(amount).ok_or(VaultError::Overflow)?;
        env.storage().instance().set(&camp_key, &new_balance);
        let zone_key = (key_zone_prefix(), campaign_id.clone());
        env.storage().instance().set(&zone_key, &public_inputs_prefix);

        FundedEvent {
            campaign_id: &campaign_id,
            amount: &amount,
            funder: &funder,
        }
        .publish(&env);

        Ok(())
    }

    /// Claim aid for a campaign.
    /// - `recipient`     : Stellar address that receives 50 USDC. Must authorize this call.
    /// - `public_inputs` : 224-byte array produced by `bb prove`.
    /// - `proof_bytes`   : UltraHonk proof produced by `bb prove`.
    ///
    /// The ZK proof guarantees:
    ///   1. The claimer was inside the zone bounding box.
    ///   2. The nullifier is unique — prevents double-claiming without revealing identity.
    ///   3. The recipient_address is bound — prevents front-running.
    pub fn claim_aid(
        env: Env,
        recipient: Address,
        public_inputs: Bytes,
        proof_bytes: Bytes,
    ) -> Result<(), VaultError> {
        if proof_bytes.len() > MAX_PROOF_BYTES {
            return Err(VaultError::PayloadTooLarge);
        }
        // Recipient must sign to authorize the payout to themselves.
        recipient.require_auth();

        // Parse public inputs.
        let (public_inputs_prefix, campaign_id, recipient_field, nullifier) =
            parse_public_inputs(&env, &public_inputs)?;
        if recipient_field != address_to_field_bytes(&env, &recipient) {
            return Err(VaultError::RecipientMismatch);
        }

        // Guard: nullifier must not already be spent.
        let nf_key = (key_nullifier_prefix(), nullifier.clone());
        if env.storage().instance().has(&nf_key) {
            return Err(VaultError::AlreadyClaimed);
        }

        // Check campaign has enough funds.
        let camp_key = (key_campaign_prefix(), campaign_id.clone());
        let balance: i128 = env
            .storage().instance().get(&camp_key)
            .unwrap_or(0i128);
        let payout = payout_amount(&env);
        if balance < payout {
            return Err(VaultError::InsufficientFunds);
        }
        let zone_key = (key_zone_prefix(), campaign_id.clone());
        let stored_prefix: Bytes = env
            .storage().instance().get(&zone_key)
            .ok_or(VaultError::InvalidPublicInputs)?;
        if stored_prefix != public_inputs_prefix {
            return Err(VaultError::InvalidPublicInputs);
        }

        // Verify ZK proof against the stored verifier contract.
        let verifier: Address = env
            .storage().instance().get(&key_verifier())
            .ok_or(VaultError::VerifierNotSet)?;
        call_verify_proof(&env, &verifier, public_inputs, proof_bytes)?;

        // Mark nullifier spent AFTER successful verification.
        env.storage().instance().set(&nf_key, &true);

        // Deduct from campaign balance and pay recipient.
        env.storage().instance().set(&camp_key, &(balance - payout));

        let token_addr: Address = env
            .storage().instance().get(&key_token())
            .ok_or(VaultError::TokenNotSet)?;
        let token_client = token::TokenClient::new(&env, &token_addr);
        token_client.transfer(&env.current_contract_address(), &recipient, &payout);

        ClaimedEvent {
            campaign_id: &campaign_id,
            nullifier: &nullifier,
            recipient: &recipient,
        }
        .publish(&env);

        Ok(())
    }

    /// Returns remaining campaign balance in token base units.
    pub fn campaign_balance(env: Env, campaign_id: BytesN<32>) -> i128 {
        let camp_key = (key_campaign_prefix(), campaign_id);
        env.storage().instance().get(&camp_key).unwrap_or(0i128)
    }

    /// Returns true if the nullifier has already been claimed.
    pub fn is_claimed(env: Env, nullifier: BytesN<32>) -> bool {
        let nf_key = (key_nullifier_prefix(), nullifier);
        env.storage().instance().has(&nf_key)
    }
}

#[cfg(test)]
mod test;
