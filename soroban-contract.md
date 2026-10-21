# Soroban Contract — HelPhone

## Stack

- **Network:** Stellar Testnet
- **Language:** Rust (Soroban SDK)
- **Tools:** `soroban-cli`, `stellar-rpc-client` (frontend)

---

## Data Structures
Memory bounds and pagination are documented in
[`docs/memory-architecture.md`](docs/memory-architecture.md). Collections are
capped at 500, page reads at 100, and verifier proof payloads at 1 MiB.


```rust
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum DataKey {
    Request(u64),          // request_id → Request
    Responder(u64, u32),  // (request_id, responder_index) → Responder
    RequestCount,          // u64 — autoincrement counter
    ResponderCount(u64),   // (request_id) → u32 — responder count per request
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Request {
    pub requester: Address,        // wallet requesting help
    pub lat: i64,                  // latitude * 1_000_000 (example: -3432 -> -34.32)
    pub lng: i64,                  // longitude * 1_000_000
    pub emergency_type: String,    // 'lost'|'fallen'|'medical'|'car'|'danger'|'other'
    pub nickname: String,          // optional alias (max 32 chars)
    pub contact: String,           // contact method (phone, Telegram, etc.)
    pub status: Status,
    pub created_at: u64,           // Unix timestamp (seconds)
    pub resolved_at: Option<u64>,  // when it was resolved/closed
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum Status {
    Pending,    // open, waiting for responders
    Enroute,    // someone is already on the way
    Resolved,   // the situation was resolved
    Cancelled,  // the requester cancelled
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Responder {
    pub responder: Address,    // wallet helping
    pub lat: i64,              // position when accepted
    pub lng: i64,
    pub eta_seconds: u32,      // estimated ETA in seconds
    pub arrived: bool,         // whether the responder actually arrived
    pub responded_at: u64,     // timestamp
}
```

---

## Functions

### `create_request`

```rust
fn create_request(
    env: Env,
    requester: Address,
    lat: i64,
    lng: i64,
    nickname: String,
    contact: String,
) -> u64
```

- Emits `RequestCreated { id, requester, lat, lng }`
- Requires `requester.require_auth()`
- Increments `RequestCount` and stores the `Request` with `status: Pending`

### `accept_request`

```rust
fn accept_request(
    env: Env,
    responder: Address,
    request_id: u64,
    lat: i64,
    lng: i64,
    eta_seconds: u32,
) -> u32  // returns the responder index
```

- Requires `responder.require_auth()`
- Requires `request.status == Pending`
- Sets `request.status = Enroute`
- Stores `Responder` and increments `ResponderCount`
- Emits `RequestAccepted { request_id, responder, eta_seconds }`

### `update_location`

```rust
fn update_location(
    env: Env,
    responder: Address,
    request_id: u64,
    lat: i32,
    lng: i32,
)
```

- **No `require_auth`** — the position is public because it is already visible on the map. The frontend signs it with an ephemeral keypair (`getTrackingSigner`) to avoid asking for a wallet signature every few seconds.
- Looks for the `Responder` matching `responder` within the request and updates `lat`/`lng`.
- Panics with `NotFound` if the responder does not exist in that request.
- Emits `LocUpd { request_id, responder, lat, lng }`.
- Trade-off: without auth, anyone can spoof a responder's position. This is acceptable for demo tracking; gate it with `responder.require_auth()` to harden it.

### `mark_arrived`

```rust
fn mark_arrived(
    env: Env,
    responder: Address,
    request_id: u64,
)
```

- Marks `responder.arrived = true`
- Emits `ResponderArrived { request_id, responder }`

### `resolve_request`

```rust
fn resolve_request(
    env: Env,
    requester: Address,
    request_id: u64,
)
```

- Requires `requester.require_auth()`
- Only the original requester can resolve it
- Sets `status: Resolved` and stores `resolved_at`
- Emits `RequestResolved { request_id }`

### `cancel_request`

```rust
fn cancel_request(
    env: Env,
    requester: Address,
    request_id: u64,
)
```

- Requires `requester.require_auth()`
- Only works if `status == Pending`
- Sets `status: Cancelled`
- Emits `RequestCancelled { request_id }`

### `get_request`

```rust
fn get_request(env: Env, request_id: u64) -> Option<Request>
```

- Read-only. Returns the request or `None`.

### `get_responder`

```rust
fn get_responder(env: Env, request_id: u64, index: u32) -> Option<Responder>
```

- Read-only. Returns a specific responder.

### `get_request_count`

```rust
fn get_request_count(env: Env) -> u64
```

### `get_active_requests`

```rust
fn get_active_requests(env: Env, max: u32) -> Vec<u64>
```

- Iterates request IDs backward from `RequestCount`, returning those that are `Pending` or `Enroute`.
- Maximum `max` results.

### `get_responder_count`

```rust
fn get_responder_count(env: Env, request_id: u64) -> u32
```

### `get_ranking`

```rust
fn get_ranking(env: Env, limit: u32) -> Vec<RankingEntry>
```

- Returns responders with the most arrivals, sorted descending.

```rust
#[contracttype]
pub struct RankingEntry {
    pub responder: Address,
    pub total_arrivals: u32,
}
```

---

## Events

```rust
#[contractevent]
pub enum HelPhoneEvent {
    RequestCreated { id: u64, requester: Address, lat: i64, lng: i64, created_at: u64 },
    RequestAccepted { request_id: u64, responder: Address, eta_seconds: u32 },
    ResponderArrived { request_id: u64, responder: Address },
    RequestResolved { request_id: u64, resolved_at: u64 },
    RequestCancelled { request_id: u64 },
    LocationUpdated { request_id: u64, responder: Address, lat: i32, lng: i32 },
}
```

The frontend subscribes to these events through Stellar RPC `getEvents()` to update the map in real time, replacing the `supabase.channel` subscriptions.

---

## Deploy (Testnet)

```bash
# 1. Build (uses Stellar CLI)
stellar contract build

# 2. Deploy a testnet
stellar contract deploy \
  --wasm target/wasm32v1-none/release/helphone_contract.wasm \
  --network testnet \
  --source helphone-deployer
```

### Deployed

| Campo | Valor |
|---|---|
| **Contract ID** | `CBO66W2GEGZZNGKLYU2R7QNUA7FKBHMDATNTJXRJS3R6GP7PVXI244YU` |
| **Network** | Stellar Testnet |
| **Tx (upload)** | `abdd1f6280305b4b544df5616cb8331b3f86024b8b16f274508b14a43d749536` |
| **Tx (deploy)** | `c713d22d379eaf7cc6983948e25e6e531483243d1223d7c9e378e7726d44b0ee` |
| **Wasm size** | 11,966 bytes |
| **Functions** | 11 exported |
| **Wallet source** | `helphone-deployer` (`GAEFEAC7...`) |
| **Source code** | `contract/contracts/helphone-contract/src/lib.rs` |

Verified: `get_request_count` -> 0, `create_request` -> returns id 1 with the `RqCreated` event emitted.

### Identity

```bash
stellar keys generate helphone-deployer --network testnet
stellar keys fund helphone-deployer --network testnet
```

---

## Frontend Migration

| Today (Supabase) | Tomorrow (Soroban) | Status |
|---|---|---|
| `supabase.from('requests').insert(...)` | `contract.create_request(...)` via `stellar-wallet-kit` | ✅ |
| `supabase.from('responders').insert(...)` | `contract.accept_request(...)` | ✅ |
| `supabase.channel(...).on('postgres_changes', ...)` | Poll every 5s with `get_active_requests` / every 3s with `get_responder_count` | ✅ |
| `supabase.from('responders').select(...).eq('status','arrived')` | `contract.get_ranking(...)` | Pending in Ranking.jsx |
| No fees | Writes pay a minimal XLM fee (~0.00001 XLM) | ✅ |
| Photos (base64 in DB) | Removed — not on-chain | ✅ |
| `gender` field | Replaced by `contact` (phone/Telegram) | ✅ |
| No emergency type | `emergency_type: String` added in contract v2 | ✅ |
| No wallet required | Connected Stellar wallet (Testnet) | ✅ |

### Modified Files

| File | Change |
|---|---|
| `src/lib/contract.js` | Helper with all Soroban contract functions |
| `src/pages/Help.jsx` | Removed Supabase, connected the contract, polling, emergency type, ZK proofs |
| `src/pages/Ranking.jsx` | Migrated to contract `get_ranking()` |
| `src/main.jsx` | WalletProvider `PUBLIC → TESTNET` |
| `src/lib/supabase.js` | **Removed** |
| `@supabase/supabase-js` | **Removed** from package.json |

### Contract v2 (deprecated — do not use)

- **Contract ID**: `CDKOCBOBOBZOE3WRIQSHRU6Q75VX5UNP7BRBEXCI4QCC5QXQIGUSJZZU`
- `Request` struct now includes `emergency_type: String`
- `create_request` receives 6 args (`emergency_type` was added between `lng` and `nickname`)

### Contract v3 (deployed — current)

- **Contract ID**: `CDP5XZ7UYCGSQBYRDYM2OEAUQJULBZPULSQXK7LGNAJTRXRG3VHZLSHY`
- **Network**: Stellar Testnet
- Added `update_location` for live responder tracking, plus the `LocUpd` event.
- **Privacy**: the frontend sends empty `nickname` and `contact` values on-chain (`createRequest(..., '', '', ...)`). Real name/contact values stay only in browser `localStorage`.
- **Location**: only a coarse location goes on-chain (`anonymizeLocation` rounds to 2 decimals, about 1 km). The exact coordinate is used only as the private witness for the ZK proof (Noir), proving "I am inside the zone" without revealing where.
- This is the default ID used by `src/lib/contract.js`; production can override it with `VITE_HELPHONE_CONTRACT_ID`.

---

## Next Steps

1. ✅ Create the Rust project with `stellar contract init`
2. ✅ Implement the contract
3. ✅ Build + Deploy a testnet
4. ✅ Migrate `Help.jsx` — remove Supabase, connect the contract
5. ✅ Migrate `Ranking.jsx` — read ranking from the contract
6. ✅ Remove `src/lib/supabase.js` and `@supabase/supabase-js`
7. ✅ ZK proof badges — dynamic instead of "SOON"
8. ⬜ Test end-to-end

---

## Open Source Sustainability Reserve (`contracts/helphone_dao`, #587)

The DAO contract holds a reserve that funds maintainers of the open source
dependencies HelPhone ships. The reserve logic is in
`contracts/helphone_dao/src/sustainability.rs`, and its entry points are on `HelPhoneDao`.

- **1% protocol fee.** `collect_sustainability_fee(payer, gross_amount)` pulls
  `gross_amount * 100 / 10_000` (`SUSTAINABILITY_FEE_BPS = 100`) of the
  configured SAC token from `payer` into the reserve. Amounts are rounded down,
  so a dust payment pays nothing.
- **DAO-voted grants.** `propose_maintainer_grant(proposer, maintainer, package,
  amount, title, description)` opens a `FundAllocation` proposal and attaches a
  `MaintainerGrant`. When the proposal passes and `execute_proposal` runs after
  the timelock, the grant is paid automatically if the reserve covers it. If the
  reserve is short, the grant stays `Pending`. Anyone can then call
  `disburse_grant(proposal_id)` once the reserve has grown. Grants attached to
  failed or cancelled proposals can never be paid.
- **Reads:** `get_sustainability_stats()` returns reserve, collected,
  disbursed, grants proposed/paid and maintainers funded (used by
  `/vault` via `getSustainabilityStats()` in `src/lib/contract.ts`).
  `get_maintainer_grant(proposal_id)` and `get_maintainer_funding(maintainer)`
  are the other two reads.
- **Admin:** `configure_sustainability(admin, reserve_token)` picks the SAC
  token. `set_voting_supply(admin, supply)` sets the quorum denominator, because
  SEP-41 tokens expose no `total_supply()`.

```bash
cd contracts/helphone_dao && cargo test          # grant lifecycle tests
stellar contract build                            # wasm32v1-none artifact
stellar contract deploy --wasm ../../target/wasm32v1-none/release/helphone_dao.wasm \
  --source helphone-deployer --network testnet -- \
  --admin <G...> --governance_token <C...>
```

Set `VITE_HELPHONE_DAO_CONTRACT_ID` to show the dependency funding stats on the
Vault dashboard.
// Implementation added

## M-of-N admin governance

`configure_multisig` stores the authorized signer set and threshold. An authorized
signer creates an admin-transfer proposal with `create_admin_proposal`; each signer
may call `approve_admin_proposal` once. `execute_admin_proposal` rejects execution
until approvals meet the threshold and permanently marks executed proposals to
prevent replay. The constructor defaults to a backwards-compatible 1-of-1 set.

## Multi-asset treasury — `aegis_vault` (#541)

`contracts/aegis_vault/src/treasury.rs` tracks a reserve per asset and enforces
per-asset daily disbursement caps. Reserves are credited by `fund_zone` and
`treasury_deposit`, and debited by `claim_aid` and `treasury_withdraw`.

| Function | Auth | Notes |
| --- | --- | --- |
| `treasury_assets()` / `treasury_reserve(asset)` | – | Registered assets and their reserves |
| `add_treasury_asset(admin, asset)` | admin | Registers an asset (idempotent) |
| `treasury_deposit(from, asset, amount)` | `from` | Asset must be registered |
| `treasury_withdraw(admin, asset, to, amount)` | admin | Counts against the daily cap |
| `set_daily_limit(admin, asset, limit)` / `daily_limit` / `spent_today` / `remaining_today` | admin (set) | Cap resets each UTC day (`timestamp / 86400`). Constructor sets the vault token to 10 default payouts (500 tokens) |
| `set_target_weights(admin, assets, weights_bps)` / `target_weight` | admin (set) | Sum ≤ 10 000 bps |
| `rebalance_plan(prices)` | – | Read-only: signed buy(+)/sell(−) per asset to reach the targets. `prices` are in `treasury_assets` order. The vault never swaps; execution is off-chain or via a DEX adapter |

A claim that would exceed the daily cap fails with `DailyLimitExceeded` (9)
before the nullifier is burned or any balance moves, so the claimant can retry
the next day. Other new errors: `UnknownAsset` (10), `InvalidWeights` (11),
`InvalidPrices` (12). `fund_zone` takes the 160-byte public-inputs prefix
(campaign id = bytes 128..160), as before.

Frontend: `getTreasurySnapshot`, `getTreasuryRebalancePlan`,
`setTreasuryDailyLimit` in `src/lib/contract.ts`; reserves render in
`VaultDashboard.jsx` via `TreasuryPanel` (refreshed every 15 s).

## Price oracle adapter — `helphone_dao` (#543)

`contracts/helphone_dao/src/oracle.rs` reads SEP-40 feeds (e.g. Reflector) via
`lastprice(asset)`. Prices are quoted against the feed's base asset, so
`convert(amount, from, to) = amount * price(from) / price(to)`, rounded down.

- **Stale guard:** a price older than `MAX_PRICE_AGE_SECS` (3600 s) aborts with
  `StalePrice` (14). One stale leg rejects the whole conversion. Prices dated
  more than 60 s in the future, or `<= 0`, abort with `InvalidPrice` (16); a
  missing price aborts with `PriceUnavailable` (15).
- **Entry points:** `set_oracle(admin, oracle)`, `get_oracle()`,
  `quote_conversion(from_token, to_token, amount)` and
  `disburse_aid(admin, recipient, source_token, payout_token, source_amount)`,
  which pays the converted amount from the DAO's balance.
- **Other errors:** `OracleNotSet` (13), `InvalidAmount` (17), `Overflow` (18).

Frontend: `getOracleQuote(from, to, amount)` (needs `VITE_HELPHONE_DAO_ID`)
maps these codes to user-facing messages (`src/lib/treasury.ts`); the dashboard
has a live quote form.

The DAO crate previously did not compile (syntax errors in `cast_vote` /
`execute_proposal`, missing `total_supply` client, non-`Copy` error enum);
those are fixed so the oracle work is testable, and governance now has tests.

## Bounded verification history (ring buffer)

`record_expert_verification` keeps at most **500** entries per wallet. When a wallet's history is full, recording a new entry overwrites the oldest one (FIFO) and emits an `Evicted` event.

| Function | Returns |
| --- | --- |
| `get_expert_verification_count(wallet)` | Verifications ever recorded, evicted ones included. Also the index the next one gets |
| `get_expert_verification_oldest(wallet)` | Index of the oldest entry still readable (`count - 500`, floored at 0) |
| `get_expert_verification_capacity()` | `500` |
| `get_expert_verification(wallet, index)` | The entry, or `None` if evicted or not yet written |

`Evicted` event: topics `["evicted", wallet]`, data `{ index, record }` where `record` is the full displaced `ExpertVerification`, so an indexer can archive it before it is unreadable on chain.

See `docs/storage-optimization.md` for the layout, rent and compatibility notes.
