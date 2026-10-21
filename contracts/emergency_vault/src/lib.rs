//! Spike #601 — incident / responder-stake storage layouts for rent benchmarking.
//!
//! One contract, two storage layouts and two storage tiers chosen at construction
//! time so the benchmark in `scripts/spikes/soroban_storage_bench.rs` can drive
//! identical workloads through each combination against the real WASM:
//!
//! * `LAYOUT_NORMALIZED` — one ledger entry per incident (`Incident(id)`) and one
//!   per responder acknowledgement (`Ack(id, responder)`), stored as native
//!   `#[contracttype]` structs.
//! * `LAYOUT_PACKED` — incidents bit-packed 32-per-entry into 20-byte slots of a
//!   `Bucket(id / 32)`; acknowledgements folded into one `AckAgg(id)` entry per
//!   incident (1024-bit responder bitmap + stake total + rolling signature
//!   commitment). Individual signatures leave ledger state and are emitted as
//!   events instead, so they stay auditable but stop paying rent.
//!
//! This is prototype code for ADR-001 (docs/adr/ADR-001-soroban-incident-storage.md).
//! Authorization is intentionally omitted: `require_auth` costs are identical
//! across layouts and would only add noise to the comparison.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    xdr::{FromXdr, ToXdr},
    Address, Bytes, BytesN, Env, IntoVal, TryFromVal, Val, Vec,
};

pub const LAYOUT_NORMALIZED: u32 = 0;
pub const LAYOUT_PACKED: u32 = 1;
pub const TIER_PERSISTENT: u32 = 0;
pub const TIER_TEMPORARY: u32 = 1;

/// Incidents per packed bucket entry.
pub const BUCKET_SLOTS: u32 = 32;
/// Packed incident slot: severity u8 | status u8 | pad u16 | lat i32 | lng i32 | opened_at u64.
pub const SLOT_BYTES: u32 = 20;
const BUCKET_BYTES: usize = (BUCKET_SLOTS * SLOT_BYTES) as usize;
/// Responders addressable by the packed bitmap.
pub const MAX_PACKED_RESPONDERS: u32 = 1024;
const BITMAP_BYTES: u32 = MAX_PACKED_RESPONDERS / 8;
// AckAgg layout: bitmap[128] | stake_total i128[16] | sig_commitment[32] | count u32[4]
const AGG_STAKE_OFF: u32 = BITMAP_BYTES;
const AGG_SIG_OFF: u32 = AGG_STAKE_OFF + 16;
const AGG_COUNT_OFF: u32 = AGG_SIG_OFF + 32;
const AGG_BYTES: usize = (AGG_COUNT_OFF + 4) as usize;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SpikeError {
    InvalidConfig = 1,
    UnknownIncident = 2,
    DuplicateAck = 3,
    ResponderLimit = 4,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Incident {
    pub severity: u32,
    pub status: u32,
    pub lat: i32,
    pub lng: i32,
    pub opened_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Ack {
    pub stake: i128,
    pub sig: BytesN<32>,
    pub at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Summary {
    pub incident: Incident,
    /// Responder count; only tracked on-chain by the packed layout
    /// (normalized derives it off-chain from `Ack` entries).
    pub responders: u32,
    pub stake_total: i128,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Layout,
    Tier,
    Incident(u32),
    Ack(u32, Address),
    Bucket(u32),
    AckAgg(u32),
    Responder(Address),
    NextResponder,
}

/// Emitted by the packed layout so individual stake signatures remain auditable
/// after being folded into the on-chain commitment.
#[contractevent(topics = ["ack"], data_format = "map")]
pub struct AckEvent {
    #[topic]
    pub incident: u32,
    pub responder: Address,
    pub stake: i128,
    pub sig: BytesN<32>,
}

// ── storage-tier dispatch ─────────────────────────────────────────────────────

fn tier(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::Tier).unwrap()
}

fn st_get<V: TryFromVal<Env, Val>>(env: &Env, k: &DataKey) -> Option<V> {
    if tier(env) == TIER_PERSISTENT {
        env.storage().persistent().get(k)
    } else {
        env.storage().temporary().get(k)
    }
}

fn st_has(env: &Env, k: &DataKey) -> bool {
    if tier(env) == TIER_PERSISTENT {
        env.storage().persistent().has(k)
    } else {
        env.storage().temporary().has(k)
    }
}

fn st_set<V: IntoVal<Env, Val>>(env: &Env, k: &DataKey, v: &V) {
    if tier(env) == TIER_PERSISTENT {
        env.storage().persistent().set(k, v)
    } else {
        env.storage().temporary().set(k, v)
    }
}

fn st_extend(env: &Env, k: &DataKey, extend_to: u32) {
    if tier(env) == TIER_PERSISTENT {
        env.storage().persistent().extend_ttl(k, extend_to, extend_to)
    } else {
        env.storage().temporary().extend_ttl(k, extend_to, extend_to)
    }
}

fn layout(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::Layout).unwrap()
}

// ── packing ───────────────────────────────────────────────────────────────────

pub fn pack(inc: &Incident) -> [u8; SLOT_BYTES as usize] {
    let mut out = [0u8; SLOT_BYTES as usize];
    out[0] = inc.severity as u8;
    out[1] = inc.status as u8;
    out[4..8].copy_from_slice(&inc.lat.to_be_bytes());
    out[8..12].copy_from_slice(&inc.lng.to_be_bytes());
    out[12..20].copy_from_slice(&inc.opened_at.to_be_bytes());
    out
}

pub fn unpack(b: &[u8; SLOT_BYTES as usize]) -> Incident {
    Incident {
        severity: b[0] as u32,
        status: b[1] as u32,
        lat: i32::from_be_bytes([b[4], b[5], b[6], b[7]]),
        lng: i32::from_be_bytes([b[8], b[9], b[10], b[11]]),
        opened_at: u64::from_be_bytes([b[12], b[13], b[14], b[15], b[16], b[17], b[18], b[19]]),
    }
}

fn read_slot(bucket: &Bytes, slot: u32) -> [u8; SLOT_BYTES as usize] {
    let mut buf = [0u8; SLOT_BYTES as usize];
    bucket
        .slice(slot * SLOT_BYTES..(slot + 1) * SLOT_BYTES)
        .copy_into_slice(&mut buf);
    buf
}

fn responder_index(env: &Env, who: &Address) -> u32 {
    let key = DataKey::Responder(who.clone());
    if let Some(i) = st_get::<u32>(env, &key) {
        return i;
    }
    let next: u32 = env.storage().instance().get(&DataKey::NextResponder).unwrap_or(0);
    if next >= MAX_PACKED_RESPONDERS {
        panic_with_error!(env, SpikeError::ResponderLimit);
    }
    st_set(env, &key, &next);
    env.storage().instance().set(&DataKey::NextResponder, &(next + 1));
    next
}

#[contract]
pub struct EmergencyVault;

#[contractimpl]
impl EmergencyVault {
    pub fn __constructor(env: Env, layout: u32, tier: u32) {
        if layout > LAYOUT_PACKED || tier > TIER_TEMPORARY {
            panic_with_error!(&env, SpikeError::InvalidConfig);
        }
        env.storage().instance().set(&DataKey::Layout, &layout);
        env.storage().instance().set(&DataKey::Tier, &tier);
    }

    pub fn open_incident(env: Env, id: u32, severity: u32, lat: i32, lng: i32) {
        let inc = Incident { severity, status: 1, lat, lng, opened_at: env.ledger().timestamp() };
        if layout(&env) == LAYOUT_NORMALIZED {
            st_set(&env, &DataKey::Incident(id), &inc);
        } else {
            let key = DataKey::Bucket(id / BUCKET_SLOTS);
            let mut bucket: Bytes = st_get(&env, &key)
                .unwrap_or_else(|| Bytes::from_array(&env, &[0u8; BUCKET_BYTES]));
            bucket.copy_from_slice((id % BUCKET_SLOTS) * SLOT_BYTES, &pack(&inc));
            st_set(&env, &key, &bucket);
        }
    }

    /// A responder stakes on an incident with a signature over the incident.
    pub fn ack(env: Env, responder: Address, id: u32, stake: i128, sig: BytesN<32>) {
        if layout(&env) == LAYOUT_NORMALIZED {
            let key = DataKey::Ack(id, responder);
            if st_has(&env, &key) {
                panic_with_error!(&env, SpikeError::DuplicateAck);
            }
            st_set(&env, &key, &Ack { stake, sig, at: env.ledger().timestamp() });
            return;
        }

        let idx = responder_index(&env, &responder);
        let key = DataKey::AckAgg(id);
        let mut agg: Bytes =
            st_get(&env, &key).unwrap_or_else(|| Bytes::from_array(&env, &[0u8; AGG_BYTES]));
        let (byte, bit) = (idx / 8, 1u8 << (idx % 8));
        let cur = agg.get(byte).unwrap();
        if cur & bit != 0 {
            panic_with_error!(&env, SpikeError::DuplicateAck);
        }
        agg.set(byte, cur | bit);

        let mut stake_buf = [0u8; 16];
        agg.slice(AGG_STAKE_OFF..AGG_SIG_OFF).copy_into_slice(&mut stake_buf);
        let total = i128::from_be_bytes(stake_buf) + stake;
        agg.copy_from_slice(AGG_STAKE_OFF, &total.to_be_bytes());

        let mut preimage = agg.slice(AGG_SIG_OFF..AGG_COUNT_OFF);
        preimage.append(&sig.clone().into());
        let commitment: BytesN<32> = env.crypto().sha256(&preimage).into();
        agg.copy_from_slice(AGG_SIG_OFF, &commitment.to_array());

        let mut count_buf = [0u8; 4];
        agg.slice(AGG_COUNT_OFF..AGG_COUNT_OFF + 4).copy_into_slice(&mut count_buf);
        agg.copy_from_slice(AGG_COUNT_OFF, &(u32::from_be_bytes(count_buf) + 1).to_be_bytes());

        st_set(&env, &key, &agg);
        AckEvent { incident: id, responder, stake, sig }.publish(&env);
    }

    pub fn summary(env: Env, id: u32) -> Summary {
        if layout(&env) == LAYOUT_NORMALIZED {
            let incident: Incident = st_get(&env, &DataKey::Incident(id))
                .unwrap_or_else(|| panic_with_error!(&env, SpikeError::UnknownIncident));
            return Summary { incident, responders: 0, stake_total: 0 };
        }
        let bucket: Bytes = st_get(&env, &DataKey::Bucket(id / BUCKET_SLOTS))
            .unwrap_or_else(|| panic_with_error!(&env, SpikeError::UnknownIncident));
        let incident = unpack(&read_slot(&bucket, id % BUCKET_SLOTS));
        let (responders, stake_total) = match st_get::<Bytes>(&env, &DataKey::AckAgg(id)) {
            None => (0, 0),
            Some(agg) => {
                let mut s = [0u8; 16];
                agg.slice(AGG_STAKE_OFF..AGG_SIG_OFF).copy_into_slice(&mut s);
                let mut c = [0u8; 4];
                agg.slice(AGG_COUNT_OFF..AGG_COUNT_OFF + 4).copy_into_slice(&mut c);
                (u32::from_be_bytes(c), i128::from_be_bytes(s))
            }
        };
        Summary { incident, responders, stake_total }
    }

    /// Extends TTL of every entry backing one incident. Normalized callers must
    /// supply the responder set (entries are not enumerable on-chain).
    pub fn extend_incident(env: Env, id: u32, responders: Vec<Address>, extend_to: u32) {
        if layout(&env) == LAYOUT_NORMALIZED {
            st_extend(&env, &DataKey::Incident(id), extend_to);
            for r in responders.iter() {
                st_extend(&env, &DataKey::Ack(id, r), extend_to);
            }
        } else {
            // Shared by up to 32 incidents; callers extending a whole bucket
            // only need to do it once — the benchmark accounts for that.
            st_extend(&env, &DataKey::Bucket(id / BUCKET_SLOTS), extend_to);
            if st_has(&env, &DataKey::AckAgg(id)) {
                st_extend(&env, &DataKey::AckAgg(id), extend_to);
            }
        }
    }

    pub fn extend_responder(env: Env, responder: Address, extend_to: u32) {
        st_extend(&env, &DataKey::Responder(responder), extend_to);
    }

    /// CPU micro-benchmark: `n` round trips through host-native XDR serialization.
    pub fn bench_native(env: Env, n: u32) -> u32 {
        let mut acc = 0u32;
        for i in 0..n {
            let inc = Incident { severity: i % 5, status: 1, lat: i as i32, lng: -(i as i32), opened_at: i as u64 };
            let xdr = inc.to_xdr(&env);
            acc = acc.wrapping_add(xdr.len());
            let back = Incident::from_xdr(&env, &xdr).unwrap();
            acc = acc.wrapping_add(back.severity);
        }
        acc
    }

    /// CPU micro-benchmark: `n` round trips through the 20-byte packed codec,
    /// including the Bytes host-object copy in and out that storage requires.
    pub fn bench_packed(env: Env, n: u32) -> u32 {
        let mut acc = 0u32;
        for i in 0..n {
            let inc = Incident { severity: i % 5, status: 1, lat: i as i32, lng: -(i as i32), opened_at: i as u64 };
            let bytes = Bytes::from_array(&env, &pack(&inc));
            acc = acc.wrapping_add(bytes.len());
            let mut buf = [0u8; SLOT_BYTES as usize];
            bytes.copy_into_slice(&mut buf);
            acc = acc.wrapping_add(unpack(&buf).severity);
        }
        acc
    }
}

#[cfg(test)]
mod test;

#[cfg(test)]
#[path = "../../../scripts/spikes/soroban_storage_bench.rs"]
mod bench;
