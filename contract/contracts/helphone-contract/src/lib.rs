#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, panic_with_error,
    symbol_short, Address, Env, String, Vec, Map, Symbol,
    IntoVal, Val,
};

// ── Constants ──────────────────────────────────────────────────
const MAX_ACTIVE_KEYS: u32 = 500;
const MAX_RANKING: u32 = 100;
const MAX_PAGE_SIZE: u32 = 100;
const MAX_EXPERT_RECORDS: u32 = 500;

// ── Data Keys ──────────────────────────────────────────────────
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum DataKey {
    Request(u64),
    Responder(u64, u32),
    RequestCount,
    ResponderCount(u64),
    ActiveRequestIds,
    // Issue #179: position of `id` within ActiveRequestIds, so removal
    // can swap-remove in O(1) instead of rebuilding the whole list.
    ActiveIndex(u64),
    RankingMap,
    ExpertVerifications(Address),
}

// ── Status ─────────────────────────────────────────────────────
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum Status {
    Pending,
    Enroute,
    Resolved,
    Cancelled,
}

// ── Structs ────────────────────────────────────────────────────
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Request {
    pub requester: Address,
    pub lat: i32,
    pub lng: i32,
    pub emergency_type: String,
    pub nickname: String,
    pub contact: String,
    pub status: Status,
    pub created_at: u64,
    pub resolved_at: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Responder {
    pub responder: Address,
    pub lat: i32,
    pub lng: i32,
    pub eta_seconds: u32,
    pub arrived: bool,
    pub responded_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RankingEntry {
    pub responder: Address,
    pub total_arrivals: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ExpertVerification {
    pub wallet: Address,
    pub action: String,
    pub tx_hash: String,
    pub proof_fingerprint: String,
    pub verified_at: u64,
}

// ── Errors ─────────────────────────────────────────────────────
#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HelPhoneError {
    NotFound = 1,
    NotAuthorized = 2,
    WrongStatus = 3,
    AlreadyArrived = 4,
}

// ── Event symbols ──────────────────────────────────────────────
const EVT_REQ_CREATED: Symbol = symbol_short!("RqCreated");
const EVT_REQ_ACCEPTED: Symbol = symbol_short!("RqAcptd");
const EVT_ARRIVED: Symbol = symbol_short!("Arrived");
const EVT_LOC_UPD: Symbol = symbol_short!("LocUpd");
const EVT_RESOLVED: Symbol = symbol_short!("Resolved");
const EVT_CANCELLED: Symbol = symbol_short!("Cancelled");
const EVT_EXPERT: Symbol = symbol_short!("Expert");

// ── Contract ───────────────────────────────────────────────────
#[contract]
pub struct HelPhone;

#[contractimpl]
impl HelPhone {
    // ── Write Functions ───────────────────────────────────────

    pub fn create_request(
        env: Env,
        requester: Address,
        lat: i32,
        lng: i32,
        emergency_type: String,
        nickname: String,
        contact: String,
    ) -> u64 {
        requester.require_auth();

        let id = Self::count_get_u64(&env, DataKey::RequestCount) + 1;
        Self::count_set(&env, DataKey::RequestCount, id);

        let now = env.ledger().timestamp();
        let request = Request {
            requester: requester.clone(),
            lat, lng, emergency_type, nickname, contact,
            status: Status::Pending,
            created_at: now,
            resolved_at: None,
        };
        Self::write_request(&env, id, &request);
        Self::active_push(&env, id);

        env.events().publish((
            EVT_REQ_CREATED, id, requester, lat, lng, now,
        ), ());

        id
    }

    pub fn accept_request(
        env: Env,
        responder: Address,
        request_id: u64,
        lat: i32,
        lng: i32,
        eta_seconds: u32,
    ) -> u32 {
        responder.require_auth();

        let mut request = Self::require_request(&env, request_id);
        if request.status != Status::Pending {
            panic_with_error!(&env, HelPhoneError::WrongStatus);
        }

        request.status = Status::Enroute;
        Self::write_request(&env, request_id, &request);

        let index = Self::count_get_u32(&env, DataKey::ResponderCount(request_id));
        Self::count_set(&env, DataKey::ResponderCount(request_id), index + 1);

        let now = env.ledger().timestamp();
        let resp = Responder {
            responder: responder.clone(),
            lat, lng, eta_seconds,
            arrived: false,
            responded_at: now,
        };
        Self::write_responder(&env, request_id, index, &resp);

        env.events().publish((
            EVT_REQ_ACCEPTED, request_id, responder, eta_seconds,
        ), ());

        index
    }

    pub fn update_location(
        env: Env,
        responder: Address,
        request_id: u64,
        lat: i32,
        lng: i32,
    ) {
        // No auth — location is public (visible on the map anyway).

        let count = Self::count_get_u32(&env, DataKey::ResponderCount(request_id));
        let mut found = false;
        for i in 0..count {
            let key = DataKey::Responder(request_id, i);
            if let Some(mut r) = env.storage().persistent().get::<DataKey, Responder>(&key) {
                if r.responder == responder {
                    r.lat = lat;
                    r.lng = lng;
                    env.storage().persistent().set(&key, &r);
                    found = true;
                    break;
                }
            }
        }
        if !found {
            panic_with_error!(&env, HelPhoneError::NotFound);
        }

        env.events().publish((EVT_LOC_UPD, request_id, responder, lat, lng), ());
    }

    pub fn mark_arrived(env: Env, responder: Address, request_id: u64) {
        responder.require_auth();

        let _request = Self::require_request(&env, request_id);
        let count: u32 = Self::count_get_u32(&env, DataKey::ResponderCount(request_id));
        let mut found = false;

        for i in 0..count {
            let key = DataKey::Responder(request_id, i);
            if let Some(mut r) = env.storage().persistent().get::<DataKey, Responder>(&key) {
                if r.responder == responder {
                    if r.arrived {
                        panic_with_error!(&env, HelPhoneError::AlreadyArrived);
                    }
                    r.arrived = true;
                    env.storage().persistent().set(&key, &r);
                    Self::ranking_increment(&env, &responder);
                    found = true;
                    break;
                }
            }
        }
        if !found {
            panic_with_error!(&env, HelPhoneError::NotFound);
        }

        env.events().publish((EVT_ARRIVED, request_id, responder), ());
    }

    pub fn resolve_request(env: Env, requester: Address, request_id: u64) {
        requester.require_auth();

        let mut request = Self::require_request(&env, request_id);
        if request.requester != requester {
            panic_with_error!(&env, HelPhoneError::NotAuthorized);
        }
        if request.status != Status::Enroute {
            panic_with_error!(&env, HelPhoneError::WrongStatus);
        }

        request.status = Status::Resolved;
        let now = env.ledger().timestamp();
        request.resolved_at = Some(now);
        Self::write_request(&env, request_id, &request);
        Self::active_remove(&env, request_id);

        env.events().publish((EVT_RESOLVED, request_id, now), ());
    }

    pub fn cancel_request(env: Env, requester: Address, request_id: u64) {
        requester.require_auth();

        let mut request = Self::require_request(&env, request_id);
        if request.requester != requester {
            panic_with_error!(&env, HelPhoneError::NotAuthorized);
        }
        if request.status != Status::Pending {
            panic_with_error!(&env, HelPhoneError::WrongStatus);
        }

        request.status = Status::Cancelled;
        Self::write_request(&env, request_id, &request);
        Self::active_remove(&env, request_id);

        env.events().publish((EVT_CANCELLED, request_id), ());
    }

    pub fn record_expert_verification(
        env: Env,
        wallet: Address,
        action: String,
        tx_hash: String,
        proof_fingerprint: String,
    ) -> u64 {
        wallet.require_auth();

        let now = env.ledger().timestamp();
        let record = ExpertVerification {
            wallet: wallet.clone(),
            action,
            tx_hash,
            proof_fingerprint,
            verified_at: now,
        };

        let key = DataKey::ExpertVerifications(wallet.clone());
        let mut records: Vec<ExpertVerification> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(Vec::new(&env));
        if records.len() >= MAX_EXPERT_RECORDS {
            records.remove(0);
        }
        records.push_back(record.clone());
        env.storage().persistent().set(&key, &records);

        env.events().publish((
            EVT_EXPERT,
            wallet,
            record.action.clone(),
            record.tx_hash.clone(),
            record.proof_fingerprint.clone(),
            now,
        ), ());

        records.len() as u64
    }

    // ── Read Functions ────────────────────────────────────────

    pub fn get_request(env: Env, request_id: u64) -> Option<Request> {
        env.storage().persistent().get(&DataKey::Request(request_id))
    }

    pub fn get_responder(env: Env, request_id: u64, index: u32) -> Option<Responder> {
        env.storage().persistent().get(&DataKey::Responder(request_id, index))
    }

    pub fn get_request_count(env: Env) -> u64 {
        Self::count_get_u64(&env, DataKey::RequestCount)
    }

    pub fn get_responder_count(env: Env, request_id: u64) -> u32 {
        Self::count_get_u32(&env, DataKey::ResponderCount(request_id))
    }

    pub fn get_active_requests(env: Env) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::ActiveRequestIds)
            .unwrap_or(Vec::new(&env))
    }


    /// Bounded read for callers that do not need the complete active set.
    pub fn get_active_requests_page(env: Env, cursor: u32, limit: u32) -> Vec<u64> {
        let ids: Vec<u64> = env.storage().persistent()
            .get(&DataKey::ActiveRequestIds).unwrap_or(Vec::new(&env));
        let take = if limit > MAX_PAGE_SIZE { MAX_PAGE_SIZE } else { limit };
        let end = core::cmp::min(ids.len(), cursor.saturating_add(take));
        let mut page = Vec::new(&env);
        let mut i = cursor;
        while i < end {
            page.push_back(ids.get(i).unwrap());
            i += 1;
        }
        page
    }

    pub fn get_ranking(env: Env) -> Vec<RankingEntry> {
        let key = DataKey::RankingMap;
        let map: Map<Address, u32> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(Map::new(&env));

        let mut entries: Vec<(u32, Address)> = Vec::new(&env);
        for item in map.iter() {
            let (addr, count) = item;
            entries.push_back((count, addr));
        }

        let n = entries.len();
        for i in 0..n {
            for j in 0..(n - 1 - i) {
                let a = entries.get(j).unwrap();
                let b = entries.get(j + 1).unwrap();
                if a.0 < b.0 {
                    entries.set(j, b);
                    entries.set(j + 1, a);
                }
            }
        }

        let limit = if n > MAX_RANKING { MAX_RANKING } else { n };
        let mut result: Vec<RankingEntry> = Vec::new(&env);
        for i in 0..limit {
            let (count, addr) = entries.get(i).unwrap();
            result.push_back(RankingEntry {
                responder: addr,
                total_arrivals: count,
            });
        }
        result
    }

    pub fn get_expert_verifications(env: Env, wallet: Address, limit: u32) -> Vec<ExpertVerification> {
        let key = DataKey::ExpertVerifications(wallet);
        let records: Vec<ExpertVerification> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(Vec::new(&env));

        let total = records.len();
        let capped = if total > limit { limit } else { total };
        let mut result: Vec<ExpertVerification> = Vec::new(&env);
        for i in 0..capped {
            result.push_back(records.get(i).unwrap());
        }
        result
    }

    // ── Storage Helpers ───────────────────────────────────────

    fn require_request(env: &Env, id: u64) -> Request {
        env.storage()
            .persistent()
            .get::<DataKey, Request>(&DataKey::Request(id))
            .unwrap_or_else(|| panic_with_error!(env, HelPhoneError::NotFound))
    }

    fn write_request(env: &Env, id: u64, request: &Request) {
        env.storage().persistent().set(&DataKey::Request(id), request);
    }

    fn write_responder(env: &Env, request_id: u64, index: u32, responder: &Responder) {
        env.storage().persistent().set(&DataKey::Responder(request_id, index), responder);
    }

    fn count_get_u64(env: &Env, key: DataKey) -> u64 {
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or(0u64)
    }

    fn count_get_u32(env: &Env, key: DataKey) -> u32 {
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or(0u32)
    }

    fn count_set(env: &Env, key: DataKey, val: impl IntoVal<Env, Val>) {
        env.storage().persistent().set(&key, &val);
    }

    // Issue #179: `get_active_requests` itself already reads this list
    // directly (O(1)) rather than scanning all request IDs — the actual
    // linear-scan cost lived here, on the write path: every removal used
    // to rebuild the entire Vec by filtering (O(n)), and eviction shifted
    // every remaining element down by one (also O(n)). Both are now O(1)
    // swap-remove, tracked via the ActiveIndex side-map. Active-set order
    // is not meaningful to callers (it's a membership set, not a queue),
    // so swapping elements around on removal/eviction is safe.

    fn active_push(env: &Env, id: u64) {
        let list_key = DataKey::ActiveRequestIds;
        let mut ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&list_key)
            .unwrap_or(Vec::new(env));

        if ids.len() >= MAX_ACTIVE_KEYS as u32 {
            // Evict the current slot 0 in O(1): move the last element
            // into slot 0 (updating its recorded index), then drop the
            // now-duplicated last slot. Which id gets evicted is
            // unspecified beyond "some existing entry" — callers only
            // rely on the set staying bounded, not on eviction order.
            if let Some(evicted_id) = ids.get(0) {
                env.storage().persistent().remove(&DataKey::ActiveIndex(evicted_id));
            }
            let last_pos = ids.len() - 1;
            if last_pos > 0 {
                if let Some(moved_id) = ids.get(last_pos) {
                    ids.set(0, moved_id);
                    env.storage().persistent().set(&DataKey::ActiveIndex(moved_id), &0u32);
                }
            }
            ids.pop_back();
        }

        let new_index = ids.len();
        ids.push_back(id);
        env.storage().persistent().set(&DataKey::ActiveIndex(id), &new_index);
        env.storage().persistent().set(&list_key, &ids);
    }

    fn active_remove(env: &Env, id: u64) {
        let index_key = DataKey::ActiveIndex(id);
        let index: u32 = match env.storage().persistent().get(&index_key) {
            Some(i) => i,
            None => return, // not active (already resolved/cancelled) — nothing to do
        };

        let list_key = DataKey::ActiveRequestIds;
        let mut ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&list_key)
            .unwrap_or(Vec::new(env));

        let last_pos = ids.len() - 1;
        if index != last_pos {
            if let Some(last_id) = ids.get(last_pos) {
                ids.set(index, last_id);
                env.storage().persistent().set(&DataKey::ActiveIndex(last_id), &index);
            }
        }
        ids.pop_back();

        env.storage().persistent().remove(&index_key);
        env.storage().persistent().set(&list_key, &ids);
    }

    fn ranking_increment(env: &Env, responder: &Address) {
        let key = DataKey::RankingMap;
        let mut map: Map<Address, u32> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(Map::new(env));
        let count = map.get(responder.clone()).unwrap_or(0);
        map.set(responder.clone(), count + 1);
        env.storage().persistent().set(&key, &map);
    }
}

mod test;
