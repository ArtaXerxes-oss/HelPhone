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
