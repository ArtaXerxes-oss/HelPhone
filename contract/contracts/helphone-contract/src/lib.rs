#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short, Address,
    Bytes, Env, String,
};

mod compression;
mod multisig;
mod nonce;
mod ring_buffer;

use ring_buffer::RingBuffer;
pub use ring_buffer::CAPACITY as VERIFICATION_CAPACITY;

pub use multisig::{Proposal, ProposalAction};

// ── Storage Keys ───────────────────────────────────────────────────
//
// Instance (cheap, contract-lifetime):
//   "admin"   → Address          current admin
//   "pending" → Address          pending new owner (optional)
//   "rcount"  → u64              total requests ever created
//   "acount"  → u32              number of active request IDs
//   ("active", u32) → u64        active request IDs by slot index
//
// Persistent (pay-to-live):
//   ("req", u64) → HelpRequest   (includes the sealed, responder-only payload)
//   ("req2", u64) → StoredHelpRequest (packed coordinates and timestamp)
//   ("req", u64) → HelpRequest (legacy entries, read through migration fallback)
//   ("rcount", request_id) → u32   responder count per request
//   ("resp", request_id, idx) → ResponderRecord
//   ("evcount", wallet) → u32      verifications ever recorded per wallet (write cursor)
//   ("ev", wallet, idx % 500) → ExpertVerification   ring buffer slot (see ring_buffer.rs)
//
// ── Footprint contract (client mirror: src/lib/footprint.ts, issue #517) ──
// The JS client inspects each invocation's storage footprint via an RPC
// simulateTransaction call before any user signature, then caches the returned
// read-only / read-write ledger-key set in memory and reuses it for identical
// repeat invocations.
//
//   * mark_arrived / resolve_request / cancel_request touch only
//     ("req2", id) / ("resp", request_id, responder_index) — fully determined
//     by the function arguments, so the client pre-bakes their footprint.
//   * create_request / accept_request / record_expert_verification append to
//     counter/slot keys whose values depend on on-chain state; their footprint
//     is left to the pre-sign simulation to derive.
//
// Both checks read config from the instance/"admin" slot; multisig state lives
// in the multisig module (multisig::configuration). Keep this map in sync with
// any storage key added here.

fn key_admin() -> soroban_sdk::Symbol {
    symbol_short!("admin")
}
fn key_pending() -> soroban_sdk::Symbol {
    symbol_short!("pending")
}
fn key_req_count() -> soroban_sdk::Symbol {
    symbol_short!("rcount")
}
fn key_active_count() -> soroban_sdk::Symbol {
    symbol_short!("acount")
}

// ── Error Codes ────────────────────────────────────────────────────
#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    NotFound = 1,
    NotAuthorized = 2,
    AlreadyExists = 3,
    WrongStatus = 4,
    NoPendingTransfer = 5,
    TransferAlreadyPending = 6,
    InvalidThreshold = 7,
    NotMultisigSigner = 8,
    DuplicateApproval = 9,
    ThresholdNotMet = 10,
    ProposalExecuted = 11,
    /// `create_request` was called without an encrypted payload.
    PayloadEmpty = 12,
    /// The encrypted payload exceeds `MAX_ENCRYPTED_PAYLOAD_BYTES`.
    PayloadTooLarge = 13,
    /// `emergency_type` is empty or longer than `MAX_EMERGENCY_TYPE_BYTES`.
    EmergencyTypeInvalid = 14,
}

// ── Types ──────────────────────────────────────────────────────────
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum Status {
    Pending,
    Enroute,
    Resolved,
    Cancelled,
}

/// Upper bound on the opaque encrypted blob, in bytes.
///
/// Mirrors `MAX_ENVELOPE_BYTES` in `src/lib/crypto.ts`, which enforces the
/// same limit client-side so an oversized payload fails locally instead of
/// reverting a signed transaction. The envelope hex-encodes its ciphertext, so
/// this is roughly twice the `MAX_PAYLOAD_PLAINTEXT_BYTES` (4 KiB) cap.
pub const MAX_ENCRYPTED_PAYLOAD_BYTES: u32 = 12288;

/// Upper bound on `emergency_type`, in bytes. Kept short because it is
/// plaintext and is indexed/filtered on by responders.
pub const MAX_EMERGENCY_TYPE_BYTES: u32 = 32;

/// A help request as stored on the ledger.
///
/// The sensitive half of the request — contact number, medical notes,
/// allergies — is **not** here in the clear. `encrypted_payload` is a sealed
/// envelope produced by the client (ECDH P-256 + HKDF-SHA256 + AES-256-GCM,
/// see `src/lib/crypto.ts`) whose content key is wrapped once per authorized
/// responder. This contract never holds a decryption key and never parses the
/// envelope; it stores opaque bytes and bounds their length.
///
/// Deliberately left in plaintext, because dispatch is impossible without them:
///   * `lat` / `lng` — responders must see where. Coarse location privacy is
///     the separate ZK/Aegis layer's job (circuits/, contracts/aegis_vault).
///   * `emergency_type` — responders filter on it to send the right aid.
///
/// ### Storage-layout note
/// This replaces the previous `nickname: String` / `contact: String` pair with
/// a single `Bytes`, which changes the XDR layout of every stored request.
/// Existing deployments need a state migration before upgrading; see
/// docs/security-architecture.md → "End-to-End Encrypted Payloads".
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct HelpRequest {
    pub id: u64,
    pub requester: Address,
    /// Latitude encoded as integer (degrees × 1_000_000)
    pub lat: i32,
    /// Longitude encoded as integer (degrees × 1_000_000)
    pub lng: i32,
    pub emergency_type: String,
    /// Opaque, sealed responder-only payload. Never readable by this contract.
    pub encrypted_payload: Bytes,
    pub status: Status,
    pub created_at: u64,
    pub resolved_at: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
struct StoredHelpRequest {
    pub id: u64,
    pub requester: Address,
    pub packed_location: soroban_sdk::BytesN<16>,
    pub emergency_type: String,
    pub nickname: String,
    pub contact: String,
    pub status: Status,
    pub resolved_at: Option<u64>,
}

fn load_request(env: &Env, id: u64) -> Option<StoredHelpRequest> {
    if let Some(stored) = env.storage().persistent().get(&(symbol_short!("req2"), id)) {
        return Some(stored);
    }
    let legacy: HelpRequest = env
        .storage()
        .persistent()
        .get(&(symbol_short!("req"), id))?;
    Some(StoredHelpRequest {
        id: legacy.id,
        requester: legacy.requester,
        packed_location: compression::pack_location(env, legacy.lat, legacy.lng, legacy.created_at),
        emergency_type: legacy.emergency_type,
        nickname: legacy.nickname,
        contact: legacy.contact,
        status: legacy.status,
        resolved_at: legacy.resolved_at,
    })
}

fn save_request(env: &Env, request: &StoredHelpRequest) {
    env.storage()
        .persistent()
        .set(&(symbol_short!("req2"), request.id), request);
}

fn request_view(request: StoredHelpRequest) -> HelpRequest {
    let (lat, lng, created_at) = compression::unpack_location(&request.packed_location);
    HelpRequest {
        id: request.id,
        requester: request.requester,
        lat,
        lng,
        emergency_type: request.emergency_type,
        nickname: request.nickname,
        contact: request.contact,
        status: request.status,
        created_at,
        resolved_at: request.resolved_at,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ResponderRecord {
    pub responder: Address,
    pub lat: i32,
    pub lng: i32,
    pub eta_seconds: u32,
    pub arrived: bool,
    pub responded_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ExpertVerification {
    pub wallet: Address,
    pub action: String,
    pub tx_hash: String,
    pub proof_fingerprint: String,
    pub recorded_at: u64,
}

/// Emitted when a wallet's verification history is full and recording a new
/// entry displaces the oldest one, so off-chain indexers can archive it.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Evicted {
    #[topic]
    pub wallet: Address,
    /// Logical index the evicted entry had.
    pub index: u32,
    pub record: ExpertVerification,
}

/// Per-wallet expert verification history, bounded to `VERIFICATION_CAPACITY`.
const VERIFICATIONS: RingBuffer = RingBuffer::new(symbol_short!("ev"), symbol_short!("evcount"));

#[contract]
pub struct HelPhone;

#[contractimpl]
impl HelPhone {
    // ── Initialisation ──────────────────────────────────────────────

    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&key_admin(), &admin);
        env.storage().instance().set(&key_req_count(), &0u64);
        env.storage().instance().set(&key_active_count(), &0u32);
        multisig::initialise(&env, &admin);
    }

    // ── Admin reads ─────────────────────────────────────────────────

    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&key_admin())
    }

    pub fn get_pending_owner(env: Env) -> Option<Address> {
        env.storage().instance().get(&key_pending())
    }

    // ── M-of-N multisig governance ──────────────────────────────────

    pub fn configure_multisig(
        env: Env,
        caller: Address,
        admins: soroban_sdk::Vec<Address>,
        threshold: u32,
    ) -> Result<(), Error> {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&key_admin())
            .ok_or(Error::NotAuthorized)?;
        if caller != admin {
            return Err(Error::NotAuthorized);
        }
        let (_, current_threshold) = multisig::configuration(&env);
        if current_threshold > 1 {
            return Err(Error::ThresholdNotMet);
        }
        if !multisig::configure(&env, &admins, threshold) {
            return Err(Error::InvalidThreshold);
        }
        env.storage().instance().remove(&key_pending());
        Ok(())
    }

    pub fn get_multisig_config(env: Env) -> (soroban_sdk::Vec<Address>, u32) {
        multisig::configuration(&env)
    }

    pub fn create_admin_proposal(
        env: Env,
        proposer: Address,
        new_admin: Address,
    ) -> Result<Proposal, Error> {
        proposer.require_auth();
        if !multisig::is_signer(&env, &proposer) {
            return Err(Error::NotMultisigSigner);
        }
        Ok(multisig::create(
            &env,
            &proposer,
            ProposalAction::TransferAdmin(new_admin),
        ))
    }

    pub fn get_admin_proposal(env: Env, id: u64) -> Option<Proposal> {
        multisig::get(&env, id)
    }

    pub fn approve_admin_proposal(env: Env, id: u64, signer: Address) -> Result<Proposal, Error> {
        signer.require_auth();
        if !multisig::is_signer(&env, &signer) {
            return Err(Error::NotMultisigSigner);
        }
        multisig::approve(&env, id, &signer).ok_or(Error::DuplicateApproval)
    }

    pub fn execute_admin_proposal(env: Env, id: u64) -> Result<(), Error> {
        let mut proposal = multisig::get(&env, id).ok_or(Error::NotFound)?;
        if proposal.executed {
            return Err(Error::ProposalExecuted);
        }
        let (_, threshold) = multisig::configuration(&env);
        if proposal.approvals < threshold {
            return Err(Error::ThresholdNotMet);
        }
        match proposal.action.clone() {
            ProposalAction::TransferAdmin(new_admin) => {
                env.storage().instance().set(&key_admin(), &new_admin)
            }
        }
        multisig::mark_executed(&env, &mut proposal);
        Ok(())
    }

    // ── Request reads ───────────────────────────────────────────────

    pub fn get_request_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&key_req_count())
            .unwrap_or(0u64)
    }

    pub fn get_active_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&key_active_count())
            .unwrap_or(0u32)
    }

    /// Return the request ID stored at active-list slot `index`.
    pub fn get_active_request_id(env: Env, index: u32) -> Option<u64> {
        env.storage()
            .instance()
            .get(&(symbol_short!("active"), index))
    }

    pub fn get_request(env: Env, id: u64) -> Option<HelpRequest> {
        load_request(&env, id).map(request_view)
    }

    pub fn get_responder_count(env: Env, request_id: u64) -> u32 {
        env.storage()
            .persistent()
            .get(&(symbol_short!("rcount"), request_id))
            .unwrap_or(0u32)
    }

    pub fn get_responder(env: Env, request_id: u64, index: u32) -> Option<ResponderRecord> {
        env.storage()
            .persistent()
            .get(&(symbol_short!("resp"), request_id, index))
    }

    /// Verifications ever recorded for `wallet`, including evicted ones. This
    /// is also the logical index the next one will get.
    pub fn get_expert_verification_count(env: Env, wallet: Address) -> u32 {
        VERIFICATIONS.total(&env, &wallet)
    }

    /// Logical index of the oldest verification still retained. Indexes below
    /// it have been evicted.
    pub fn get_expert_verification_oldest(env: Env, wallet: Address) -> u32 {
        VERIFICATIONS.oldest(&env, &wallet)
    }

    /// Maximum verifications retained per wallet.
    pub fn get_expert_verification_capacity(_env: Env) -> u32 {
        VERIFICATION_CAPACITY
    }

    /// Read by logical index. `None` if it was evicted or does not exist yet.
    pub fn get_expert_verification(
        env: Env,
        wallet: Address,
        index: u32,
    ) -> Option<ExpertVerification> {
        VERIFICATIONS.get(&env, &wallet, index)
    }

    // ── Compatibility shim — test snapshot helper ────────────────────
    // The existing test snapshots call get_active_requests() and
    // get_expert_verifications(wallet, limit). We expose read-only helpers
    // that the Rust test suite can call; the JS client uses individual
    // getters above.

    pub fn get_active_requests(env: Env) -> u32 {
        Self::get_active_count(env)
    }

    pub fn get_expert_verifications(env: Env, wallet: Address, limit: u32) -> u32 {
        // Only retained entries can be read back, so cap by those, not the lifetime total.
        let retained = VERIFICATIONS.len(&env, &wallet);
        if limit < retained {
            limit
        } else {
            retained
        }
    }

    // ── Emergency Request Lifecycle ─────────────────────────────────

    /// Broadcast a help request.
    ///
    /// `encrypted_payload` is an opaque sealed envelope (JSON, hex-encoded
    /// ciphertext) built client-side. The contract validates only that it is
    /// present and within `MAX_ENCRYPTED_PAYLOAD_BYTES`; it cannot read it and
    /// holds no key that could. Responders pull the envelope, then decrypt it
    /// locally with their own private key.
    ///
    /// # Errors
    /// * `PayloadEmpty` — no payload supplied; plaintext contact details are
    ///   no longer accepted at all.
    /// * `PayloadTooLarge` — longer than `MAX_ENCRYPTED_PAYLOAD_BYTES`.
    /// * `EmergencyTypeInvalid` — empty or over-long dispatch category.
    #[allow(clippy::too_many_arguments)]
    pub fn create_request(
        env: Env,
        requester: Address,
        lat: i32,
        lng: i32,
        emergency_type: String,
        encrypted_payload: Bytes,
    ) -> Result<u64, Error> {
        requester.require_auth();

        if encrypted_payload.is_empty() {
            return Err(Error::PayloadEmpty);
        }
        if encrypted_payload.len() > MAX_ENCRYPTED_PAYLOAD_BYTES {
            return Err(Error::PayloadTooLarge);
        }
        if emergency_type.is_empty() || emergency_type.len() > MAX_EMERGENCY_TYPE_BYTES {
            return Err(Error::EmergencyTypeInvalid);
        }

        let count = Self::get_request_count(env.clone()) + 1;
        env.storage().instance().set(&key_req_count(), &count);
        let req = StoredHelpRequest {
            id: count,
            requester,
            packed_location: compression::pack_location(&env, lat, lng, env.ledger().timestamp()),
            emergency_type,
            encrypted_payload,
            status: Status::Pending,
            resolved_at: None,
        };
        save_request(&env, &req);
        // Append to active list
        let active_count = Self::get_active_count(env.clone());
        env.storage()
            .instance()
            .set(&(symbol_short!("active"), active_count), &count);
        env.storage()
            .instance()
            .set(&key_active_count(), &(active_count + 1));
        Ok(count)
    }

    pub fn accept_request(
        env: Env,
        responder: Address,
        request_id: u64,
        lat: i32,
        lng: i32,
        eta_seconds: u32,
    ) -> Result<u32, Error> {
        responder.require_auth();
        let mut req = load_request(&env, request_id).ok_or(Error::NotFound)?;
        if req.status != Status::Pending {
            return Err(Error::WrongStatus);
        }
        req.status = Status::Enroute;
        save_request(&env, &req);

        let idx: u32 = env
            .storage()
            .persistent()
            .get(&(symbol_short!("rcount"), request_id))
            .unwrap_or(0u32);
        let record = ResponderRecord {
            responder,
            lat,
            lng,
            eta_seconds,
            arrived: false,
            responded_at: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&(symbol_short!("resp"), request_id, idx), &record);
        env.storage()
            .persistent()
            .set(&(symbol_short!("rcount"), request_id), &(idx + 1));
        Ok(idx)
    }

    pub fn mark_arrived(
        env: Env,
        responder: Address,
        request_id: u64,
        responder_index: u32,
    ) -> Result<(), Error> {
        responder.require_auth();
        let mut r: ResponderRecord = env
            .storage()
            .persistent()
            .get(&(symbol_short!("resp"), request_id, responder_index))
            .ok_or(Error::NotFound)?;
        if r.responder != responder {
            return Err(Error::NotAuthorized);
        }
        if r.arrived {
            return Err(Error::AlreadyExists);
        }
        r.arrived = true;
        env.storage()
            .persistent()
            .set(&(symbol_short!("resp"), request_id, responder_index), &r);
        Ok(())
    }

    pub fn resolve_request(env: Env, requester: Address, request_id: u64) -> Result<(), Error> {
        requester.require_auth();
        let mut req = load_request(&env, request_id).ok_or(Error::NotFound)?;
        if req.requester != requester {
            return Err(Error::NotAuthorized);
        }
        if req.status != Status::Enroute {
            return Err(Error::WrongStatus);
        }
        req.status = Status::Resolved;
        req.resolved_at = Some(env.ledger().timestamp());
        save_request(&env, &req);
        Ok(())
    }

    pub fn cancel_request(env: Env, requester: Address, request_id: u64) -> Result<(), Error> {
        requester.require_auth();
        let mut req = load_request(&env, request_id).ok_or(Error::NotFound)?;
        if req.requester != requester {
            return Err(Error::NotAuthorized);
        }
        if req.status != Status::Pending {
            return Err(Error::WrongStatus);
        }
        req.status = Status::Cancelled;
        save_request(&env, &req);
        Ok(())
    }

    pub fn record_expert_verification(
        env: Env,
        wallet: Address,
        action: String,
        tx_hash: String,
        proof_fingerprint: String,
    ) -> Result<u32, Error> {
        wallet.require_auth();
        let ev = ExpertVerification {
            wallet: wallet.clone(),
            action,
            tx_hash,
            proof_fingerprint,
            recorded_at: env.ledger().timestamp(),
        };
        let outcome = VERIFICATIONS.push(&env, &wallet, &ev);
        if let Some((index, record)) = outcome.evicted {
            Evicted {
                wallet,
                index,
                record,
            }
            .publish(&env);
        }
        // Total recorded so far (unchanged return contract: count after this push).
        Ok(outcome.index + 1)
    }

    // ── Two-Step Ownership Transfer ─────────────────────────────────
    //
    // Pattern: current owner calls `propose_transfer(new_owner)` which
    // stores `new_owner` under the "pending" key.  The new owner calls
    // `accept_transfer()` to atomically claim ownership.  Either party
    // can call `revoke_transfer()` to cancel the pending handoff.
    //
    // Why two steps instead of single-step?
    //   Single-step (set admin = new_addr) cannot verify that the new
    //   address is reachable and willing to manage the contract.  A typo
    //   irretrievably locks ownership.  The two-step approach requires the
    //   new owner to sign `accept_transfer`, proving they control the key.

    /// Propose transferring ownership to `new_owner`.
    /// Only the current admin may call this.  Replaces any existing
    /// pending transfer (e.g. to correct a typo without revoking first).
    pub fn propose_transfer(
        env: Env,
        current_owner: Address,
        new_owner: Address,
    ) -> Result<(), Error> {
        current_owner.require_auth();
        let (_, threshold) = multisig::configuration(&env);
        if threshold > 1 {
            return Err(Error::ThresholdNotMet);
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&key_admin())
            .ok_or(Error::NotAuthorized)?;
        if admin != current_owner {
            return Err(Error::NotAuthorized);
        }
        env.storage().instance().set(&key_pending(), &new_owner);
        Ok(())
    }

    /// Accept the pending ownership transfer.
    /// Only the nominated address may call this.  On success the caller
    /// becomes the new admin and the pending slot is cleared.
    pub fn accept_transfer(env: Env, new_owner: Address) -> Result<(), Error> {
        new_owner.require_auth();
        let pending: Address = env
            .storage()
            .instance()
            .get(&key_pending())
            .ok_or(Error::NoPendingTransfer)?;
        if pending != new_owner {
            return Err(Error::NotAuthorized);
        }
        env.storage().instance().set(&key_admin(), &new_owner);
        env.storage().instance().remove(&key_pending());
        Ok(())
    }

    /// Revoke a pending ownership transfer.
    /// Callable by either the current admin (cancels their proposal) or
    /// the nominated new_owner (declines the handoff).
    pub fn revoke_transfer(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        let pending: Address = env
            .storage()
            .instance()
            .get(&key_pending())
            .ok_or(Error::NoPendingTransfer)?;
        let admin: Address = env
            .storage()
            .instance()
            .get(&key_admin())
            .ok_or(Error::NotAuthorized)?;
        if caller != admin && caller != pending {
            return Err(Error::NotAuthorized);
        }
        env.storage().instance().remove(&key_pending());
        Ok(())
    }
}

#[cfg(test)]
mod test;
