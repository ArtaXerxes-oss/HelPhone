# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Dev server at http://localhost:3000 (auto-opens)
npm run build    # Production build → dist/
npm run preview  # Preview production build
```

No tests or linting configured yet.

## Environment Variables

`.env` is required for the `/help` page:

```
VITE_MAPBOX_TOKEN=...   # Mapbox GL access token
```

## Architecture

React 19 + Vite app with three routes defined in `src/main.jsx`:

| Route | Component | Role |
|-------|-----------|------|
| `/` | `src/App.jsx` | Landing page (single large file, ~40KB) |
| `/help` | `src/pages/Help.jsx` | Interactive emergency map |
| `/ranking` | `src/pages/Ranking.jsx` | On-chain responder leaderboard |

`src/main.jsx` wraps the entire app in `WalletProvider` from `stellar-wallet-kit` (Stellar testnet, dark purple theme) and `BrowserRouter`. All three routes share the wallet context.

### Key patterns in App.jsx (landing page)

- **`RevealDiv`** — wraps sections and drives scroll-triggered fade-in via `Intersection Observer`. Usage: `<RevealDiv index={getNextRevealIdx()} ...>`. The counter resets each render via `revealIdxRef` (a ref, not state). Fallback timeout at 4.5s ensures reveals fire even if the observer fails.
- **Video ping-pong loop** — `videoRef` drives the hero video: plays forward to end, then reverses frame-by-frame via `requestAnimationFrame`, then repeats.
- **All styles are inline JSX** — no CSS modules, no Tailwind. Only `src/App.css` exists, containing keyframe definitions (`mdblink`, `mdpulse`, `mddash`, `mdfloat`).
- **SVG map** — the community map is an inline SVG with SMIL `<animate>` elements. This works natively in JSX.

### Key patterns in Help.jsx

- **Mode toggle** — `mode` state switches between `'get'` (request help) and `'offer'` (respond to others). Each mode has its own map markers and sidebar flow.
- **Character system** — `CHARS` groups PNG names by gender; `pickChar(gender, seed)` deterministically picks one by hashing the seed string. Character images resolve from `/assets/chars/{name}.png`.
- **ZK proof badges** — `proofs` state tracks three signals: `location` (geolocation set), `humanity` (funded Stellar wallet via `checkAccount`), `reputation` (prior arrivals on-chain via `getRanking`).
- **Polling** — offer mode polls active requests every 5s; get mode polls responder count every 3s. Both use `setInterval` inside `useEffect` with `mounted` guard.
- **Mobile drawer** — sidebar becomes a bottom sheet on mobile via CSS class `hp-mobile-open` toggled on the `aside` ref.
- **Profile persistence** — nickname + contact stored in `localStorage` key `hp_profile`. Loaded via `loadProfile()` on mount.
- **Inline `<style>`** — responsive CSS injected at the bottom of the JSX return via a `<style>` tag (media query at 768px).

### Design tokens (inline, not in a tokens file)

| Token | Value | Usage |
|-------|-------|-------|
| Primary teal | `#234B4E` | Headers, primary text |
| Accent coral | `#FF7A6B` | CTAs, emergency indicators |
| Purple | `#7357FF` | Community/responders |
| Cream bg | `#ECE0CC` | Light sections |
| Teal accent | `#3F8487` | Secondary elements |
| Muted | `#a2a586` | Secondary CTA |

### Asset paths

Vite resolves assets relative to the project root. Use `assets/hero-nokia.mp4` (not `/assets/...`) in App.jsx. In Help.jsx character images use `/assets/chars/${name}.png` (absolute, from public/). Character PNGs live in `public/assets/chars/`. The `screens/` and `uploads/` directories are design references — not imported in the build.

## Soroban contract integration (`src/lib/contract.js`)

All on-chain interactions go through `src/lib/contract.js`. Contract is deployed on Stellar testnet:

- `VITE_HELPHONE_CONTRACT_ID` / default contract = `CDP5XZ7UYCGSQBYRDYM2OEAUQJULBZPULSQXK7LGNAJTRXRG3VHZLSHY`
- RPC: `https://soroban-testnet.stellar.org`

**Two interaction patterns:**

1. **Reads** — `simulateRead(call)`: builds a throwaway transaction from a random keypair, simulates it, returns `sim.result.retval`. No wallet needed.
2. **Writes** — `sendWrite(rawTx, wallet)`: simulate → assemble → sign via `wallet.signTransaction()` → submit → poll up to 30s for `SUCCESS`.

**Coordinate encoding** — lat/lng are stored as integers: `Math.round(lat * 1000000)` → `i32`. Decode by dividing by 1,000,000.

**Exported functions:**
- Reads: `getRequest`, `getResponder`, `getActiveRequests`, `getRequestCount`, `getResponderCount`, `getRanking`, `checkAccount`
- Writes: `createRequest`, `acceptRequest`, `markArrived`, `resolveRequest`, `cancelRequest`

## Aegis Protocol (ZK + Soroban layer)

Independent layer from the frontend; not yet wired to the app.

```
circuits/          Noir ZK circuit (runs in browser via WASM)
contracts/
  noir_verifier/   Soroban contract wrapping ultrahonk_rust_verifier
  aegis_vault/     Soroban contract: fund_zone / claim_aid / nullifier registry
app/               (not built yet) Next.js + Mapbox + Freighter wallet
```

**Flow**: user proves location privately → Noir generates proof + nullifier → `aegis_vault.claim_aid()` verifies on-chain → pays 50 USDC. Coordinates never leave the client.

### ZK circuit (`circuits/src/main.nr`)

- Tool versions: **nargo 1.0.0-beta.9** + **bb v0.87.0** (UltraHonk backend). Pin these — other versions break the verifier contract.
- Private inputs: `user_x`, `user_y`, `secret_id`. Public inputs: bounding box (4 × u64), `campaign_id`, `recipient_address`.
- Coordinates encoded as integers: `stored_lon = floor(lon × 1e7) + 1_800_000_000` (fits u64, avoids negatives).
- Nullifier: `Poseidon2([secret_id, campaign_id, 0, 0], width=4)[0]` — one claim per user per campaign.
- Output (return value) is the nullifier; it becomes the last 32-byte chunk of `public_inputs` passed to the contract.

Build circuit:
```bash
cd circuits
nargo compile          # → target/aegis.json  (used to generate VK)
nargo prove            # generates proof using Prover.toml values (local test)
bb write_vk -b target/aegis.json -o target/vk   # extract VK for contract deploy
```

### Soroban contracts (`contracts/`)

`noir_verifier` wraps `ultrahonk_rust_verifier` — deployed once, stores VK on-chain, exposes `verify_proof(public_inputs, proof_bytes)`.

`aegis_vault` depends on `noir_verifier` via `{ path = "../noir_verifier" }`. Key entry points:
- `__constructor(verifier: Address, token: Address, admin: Address)` — set verifier contract, USDC token, admin, and the default 50 USDC payout.
- `set_payout_amount(admin, amount)` / `payout_amount()` — admin-only payout configuration in token base units.
- `fund_zone(funder, campaign_id, amount)` — pull USDC from funder.
- `claim_aid(recipient, public_inputs: Bytes[224], proof_bytes)` — verify ZK proof, check nullifier not spent, pay the configured payout amount.
- `campaign_balance(campaign_id)` / `is_claimed(nullifier)` — read-only helpers.

**Public inputs layout** (224 bytes = 7 × 32 BE):
```
[  0.. 32] box_x_min
[ 32.. 64] box_x_max
[ 64.. 96] box_y_min
[ 96..128] box_y_max
[128..160] campaign_id
[160..192] recipient_address (Stellar pubkey as Field)
[192..224] nullifier (circuit return value)
```

Build contracts:
```bash
cd contracts/aegis_vault
cargo build --target wasm32-unknown-unknown --release
# or via Stellar CLI:
stellar contract build
```

The `soroban-sdk` dependency is pinned to a specific git rev — do not bump without checking Stellar testnet compatibility. The `contract/Cargo.toml` at root is a Rust workspace that includes `contracts/*`.

## Files outside the Vite build

- **`support.js`** — Generated dc-runtime bundle. Header says: `GENERATED from dc-runtime/src/*.ts — do not edit. Rebuild with cd dc-runtime && bun run build`. Used only by the `.dc.html` prototype files.
- **`*.dc.html`** (`HelPhone Prototype.dc.html`, `MapDot.dc.html`) — Standalone design prototypes that boot via `support.js`. Open directly in a browser; they are not part of the Vite app.

## Gotchas

- Port 3000 is hardcoded in `vite.config.js` — change there if occupied.
- The video reverse loop uses a tight `requestAnimationFrame` — disable if performance degrades on low-end devices.
- `RevealDiv` index is tracked via `revealIdxRef` (a ref, not state) so it resets correctly on re-render without triggering extra renders.
- Do not move `revealIdxRef.current = 0` — it must reset at the top of the render function before any `getNextRevealIdx()` calls.
- `VITE_MAPBOX_TOKEN` missing = blank map on `/help`. The Mapbox style URLs use a custom style (`kl0ren/cmqn3p0zx...`) requiring this token.
- `checkAccount` in Help.jsx determines "Proof of Humanity" — it checks whether the wallet address has funded balances on testnet via `server.getAccount`.
- Ranking period tabs (`This Week`, `This Month`, `All Time`) are UI-only — all three call the same `get_ranking` contract function (no on-chain period filter).
