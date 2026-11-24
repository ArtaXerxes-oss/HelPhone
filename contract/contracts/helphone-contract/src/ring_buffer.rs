//! Bounded per-owner ring buffer in persistent storage (#531).
//!
//! An append-only history keyed by `(owner, index)` grows forever, and every
//! entry keeps costing rent. `RingBuffer` caps that at [`CAPACITY`] entries per
//! owner: once full, each push overwrites the oldest entry (FIFO eviction) and
//! hands it back to the caller so it can announce the eviction.
//!
//! # Layout
//!
//! Two persistent keys, both of which the unbounded history already used:
//!
//! ```text
//! (count_sym, owner)        -> u32   total pushes ever (the write cursor)
//! (data_sym,  owner, slot)  -> V     slot = index % CAPACITY
//! ```
//!
//! `index` is a monotonically increasing logical position. While fewer than
//! `CAPACITY` entries exist, `slot == index`, so buffers written before this
//! module existed read back unchanged: no migration.
//!
//! The live window is `oldest ..= total - 1` where
//! `oldest = total.saturating_sub(CAPACITY)`. Indexes below `oldest` have been
//! evicted and read as `None`.
//!
//! # Rent
//!
//! Each push extends the TTL of the slot it wrote and of the counter. Because
//! the buffer is bounded, so is its rent. Persistent entries that do lapse are
//! archived, not deleted, and can be restored.

use soroban_sdk::{Address, Env, IntoVal, Symbol, TryFromVal, Val};

/// Entries kept per owner before the oldest is evicted.
pub const CAPACITY: u32 = 500;

/// Bump a touched entry when its TTL falls under ~30 days (5 s ledgers)...
pub const TTL_THRESHOLD: u32 = 17_280 * 30;
/// ...back up to ~90 days.
pub const TTL_EXTEND_TO: u32 = 17_280 * 90;

/// What a push did.
#[derive(Debug, PartialEq, Eq)]
pub struct PushOutcome<V> {
    /// Logical index the new value was stored at.
    pub index: u32,
    /// The entry this push displaced, with its logical index, once the buffer is full.
    pub evicted: Option<(u32, V)>,
}

/// A ring buffer namespace: which persistent keys hold the data and the cursor.
#[derive(Clone)]
pub struct RingBuffer {
    data: Symbol,
    count: Symbol,
}

impl RingBuffer {
    pub const fn new(data: Symbol, count: Symbol) -> Self {
        Self { data, count }
    }

    /// Total pushes ever made for `owner` (evicted ones included).
    pub fn total(&self, env: &Env, owner: &Address) -> u32 {
        env.storage()
            .persistent()
            .get(&(self.count.clone(), owner.clone()))
            .unwrap_or(0u32)
    }

    /// Logical index of the oldest entry still retained.
    pub fn oldest(&self, env: &Env, owner: &Address) -> u32 {
        self.total(env, owner).saturating_sub(CAPACITY)
    }

    /// Entries currently retained (never more than [`CAPACITY`]).
    pub fn len(&self, env: &Env, owner: &Address) -> u32 {
        self.total(env, owner) - self.oldest(env, owner)
    }

    /// Read by logical index. `None` if it was evicted or never written.
    pub fn get<V>(&self, env: &Env, owner: &Address, index: u32) -> Option<V>
    where
        V: TryFromVal<Env, Val>,
    {
        let total = self.total(env, owner);
        if index >= total || index < total.saturating_sub(CAPACITY) {
            return None;
        }
        env.storage()
            .persistent()
            .get(&(self.data.clone(), owner.clone(), index % CAPACITY))
    }

    /// Append `value`, evicting the oldest entry if the buffer is full.
    pub fn push<V>(&self, env: &Env, owner: &Address, value: &V) -> PushOutcome<V>
    where
        V: IntoVal<Env, Val> + TryFromVal<Env, Val>,
    {
        let index = self.total(env, owner);
        let next = index
            .checked_add(1)
            .expect("ring buffer index overflowed u32");
        let slot_key = (self.data.clone(), owner.clone(), index % CAPACITY);
        let storage = env.storage().persistent();

        // Once full, the slot we are about to overwrite holds the oldest entry
        // (index - CAPACITY): read it before it is gone.
        let evicted = if index >= CAPACITY {
            storage
                .get::<_, V>(&slot_key)
                .map(|old| (index - CAPACITY, old))
        } else {
            None
        };

        storage.set(&slot_key, value);
        storage.extend_ttl(&slot_key, TTL_THRESHOLD, TTL_EXTEND_TO);

        let count_key = (self.count.clone(), owner.clone());
        storage.set(&count_key, &next);
        storage.extend_ttl(&count_key, TTL_THRESHOLD, TTL_EXTEND_TO);

        PushOutcome { index, evicted }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::HelPhone;
    use soroban_sdk::{symbol_short, testutils::Address as _};

    const RING: RingBuffer = RingBuffer::new(symbol_short!("t"), symbol_short!("tcount"));

    /// Storage is only reachable from inside a contract. Every call below is
    /// its own frame, as on the network, where one invocation may write at most
    /// 50 ledger entries: a single frame cannot hold a full buffer's writes.
    struct Fixture {
        env: Env,
        id: Address,
    }

    impl Fixture {
        fn new() -> Self {
            let env = Env::default();
            let admin = Address::generate(&env);
            let id = env.register(HelPhone, (admin,));
            Self { env, id }
        }

        fn owner(&self) -> Address {
            Address::generate(&self.env)
        }

        fn push(&self, owner: &Address, v: u32) -> PushOutcome<u32> {
            self.env.as_contract(&self.id, || RING.push(&self.env, owner, &v))
        }

        fn get(&self, owner: &Address, i: u32) -> Option<u32> {
            self.env.as_contract(&self.id, || RING.get(&self.env, owner, i))
        }

        fn total(&self, owner: &Address) -> u32 {
            self.env.as_contract(&self.id, || RING.total(&self.env, owner))
        }

        fn oldest(&self, owner: &Address) -> u32 {
            self.env.as_contract(&self.id, || RING.oldest(&self.env, owner))
        }

        fn len(&self, owner: &Address) -> u32 {
            self.env.as_contract(&self.id, || RING.len(&self.env, owner))
        }
    }

    #[test]
    fn empty_buffer_reads_as_empty() {
        let f = Fixture::new();
        let o = f.owner();
        assert_eq!(f.total(&o), 0);
        assert_eq!(f.oldest(&o), 0);
        assert_eq!(f.len(&o), 0);
        assert_eq!(f.get(&o, 0), None);
    }

    #[test]
    fn push_reports_index_and_no_eviction_until_full() {
        let f = Fixture::new();
        let o = f.owner();
        for n in 0..CAPACITY {
            assert_eq!(f.push(&o, n), PushOutcome { index: n, evicted: None });
        }
        assert_eq!(f.len(&o), CAPACITY);
    }

    #[test]
    fn full_buffer_returns_the_displaced_entry_with_its_index() {
        let f = Fixture::new();
        let o = f.owner();
        for n in 0..CAPACITY {
            f.push(&o, n * 10);
        }
        let outcome = f.push(&o, 9_999);
        assert_eq!(outcome.index, CAPACITY);
        assert_eq!(outcome.evicted, Some((0, 0)));
        assert_eq!(f.push(&o, 8_888).evicted, Some((1, 10)));
    }

    #[test]
    fn eviction_is_strictly_fifo_across_multiple_wraps() {
        let f = Fixture::new();
        let o = f.owner();
        let total = CAPACITY * 2 + 37;
        let mut next_evicted = 0u32;
        for n in 0..total {
            if let Some((idx, val)) = f.push(&o, n).evicted {
                // Entries leave in exactly the order they arrived, carrying their own value.
                assert_eq!(idx, next_evicted);
                assert_eq!(val, idx);
                next_evicted += 1;
            }
        }
        assert_eq!(next_evicted, total - CAPACITY);

        let oldest = total - CAPACITY;
        assert_eq!(f.total(&o), total);
        assert_eq!(f.oldest(&o), oldest);
        assert_eq!(f.len(&o), CAPACITY);

        for gone in [0, 1, CAPACITY - 1, CAPACITY, oldest - 1] {
            assert_eq!(f.get(&o, gone), None, "index {gone} should be evicted");
        }
        for live in oldest..total {
            assert_eq!(f.get(&o, live), Some(live), "index {live} corrupted");
        }
        assert_eq!(f.get(&o, total), None);
    }

    #[test]
    fn owners_do_not_share_slots() {
        let f = Fixture::new();
        let (a, b) = (f.owner(), f.owner());
        for n in 0..CAPACITY + 5 {
            f.push(&a, n);
        }
        f.push(&b, 777);
        assert_eq!(f.oldest(&a), 5);
        assert_eq!(f.oldest(&b), 0);
        assert_eq!(f.get(&b, 0), Some(777));
    }
}
