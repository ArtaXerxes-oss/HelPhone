# Stellar/ZK Runbook

## Verified Local Toolchain

- Noir/Nargo: `1.0.0-beta.9`
- Barretenberg: `bb v0.87.0`
- Rust via rustup: `~/.cargo/bin/rustc 1.96.0`
- Stellar CLI: `stellar 25.2.0`

The machine also has Homebrew `rustc 1.90.0` earlier in the default shell `PATH`.
Use the rustup binaries explicitly for Soroban commands:

```bash
RUSTC=/Users/paukoh/.cargo/bin/rustc /Users/paukoh/.cargo/bin/cargo test
RUSTC=/Users/paukoh/.cargo/bin/rustc /Users/paukoh/.cargo/bin/cargo build --target wasm32v1-none --release
```

## Verified Commands

Frontend:

```bash
npm run build
```

HelPhone contract:

```bash
cd contract
RUSTC=/Users/paukoh/.cargo/bin/rustc /Users/paukoh/.cargo/bin/cargo test
RUSTC=/Users/paukoh/.cargo/bin/rustc /Users/paukoh/.cargo/bin/cargo build --target wasm32v1-none --release
```

UltraHonk verifier:

```bash
cd contracts/noir_verifier
./tests/build_circuits.sh
RUSTC=/Users/paukoh/.cargo/bin/rustc /Users/paukoh/.cargo/bin/cargo build --target wasm32v1-none --release
RUSTC=/Users/paukoh/.cargo/bin/rustc /Users/paukoh/.cargo/bin/cargo test
```

Aegis Vault:

```bash
cd contracts/aegis_vault
RUSTC=/Users/paukoh/.cargo/bin/rustc /Users/paukoh/.cargo/bin/cargo test
RUSTC=/Users/paukoh/.cargo/bin/rustc /Users/paukoh/.cargo/bin/cargo build --target wasm32v1-none --release
```

## WASM Outputs

- `contract/target/wasm32v1-none/release/helphone_contract.wasm`
- `contracts/noir_verifier/target/wasm32v1-none/release/ultrahonk_soroban_contract.wasm`
- `contracts/aegis_vault/target/wasm32v1-none/release/aegis_vault.wasm`

## Aegis Funding Flow

Deploy `aegis_vault` with the verifier contract, reward token, and payout admin
address. The constructor initializes the responder payout to 50 USDC in token
base units. The admin can later call `set_payout_amount(admin, amount)` to adjust
the payout for emergency severity, token price changes, or governance decisions.

`aegis_vault.fund_zone` now requires the 160-byte campaign prefix:

```text
box_x_min | box_x_max | box_y_min | box_y_max | campaign_id
```

Claims must use public inputs with the same prefix. This prevents users from
creating arbitrary self-selected location boxes for a funded campaign.

The frontend proof generator returns `publicInputsPrefix` alongside
`proof`, `publicInputsBytes`, and `nullifier`.

## ⚠️ Verification Key (VK) Rotation Safety (ISP-051)

### Critical: All Verifiers Must Rotate Atomically

After compiling a new circuit (`nargo compile`) that changes the VK, **all four verification layers** must use the matching VK:

1. **Client PWA** (`public/zk-assets/vk.json`)
2. **Server verification** (`server/routes/zk.ts`)  
3. **Recursive verifier** (`circuits/recursive_verifier`)
4. **Soroban on-chain** (vk_hash in contract state)

### Symptoms of VK Mismatch

- Client logs: `vk_hash mismatch: expected X, got Y — proceeding (cached)`
  (documented symptom only; this repo has no code that emits that line. The
  current client code fails closed, see "Signed VK manifest" below.)
- Server rejects proof: `UltraHonk verification failed: vk mismatch`
- Recursive verifier panics: `Inner VK constant mismatch`
- **Security risk**: Stale PWA cache accepts forged credentials after rotation

### Signed VK manifest and rotation gate (#936, #937)

- `public/zk-assets/vk-manifest.json` is the signed statement of the current VK:
  `vkVersion` (only increases), `vkHash`, `supersedes` (every earlier hash),
  `issuedAt`, and `graceUntil`. The PWA verifies it in `src/lib/vkManifest.js`
  with the ECDSA P-256 key pinned as `VK_MANIFEST_PUBLIC_KEY_JWK`.
- A cached VK is rejected when it is superseded, unknown, or from another
  version. Offline use is allowed only until the signed `graceUntil`. A manifest
  with a bad signature is never accepted, and the cache is not used as a fallback.
- **Until the signing key is provisioned, `VK_MANIFEST_PUBLIC_KEY_JWK` stays
  `null` and every manifest is rejected (fail closed).** Pinning the key is a
  maintainer decision made in the signing ceremony.
- `node scripts/vk-rotate.mjs check [--onchain 0x…]` exits 1 when any layer
  (manifest, recursive pin, on-chain `vk_hash`) is missing or disagrees. That is
  the partial-rotation block.
- `node scripts/vk-rotate.mjs publish …` refuses to write a manifest until
  `circuits/recursive_verifier/inner-vk.json` already pins the new hash.

### Rotation Checklist (partly automated)

- [ ] Compile new circuit: `bash circuits/recursive_verifier/build.sh` (nargo 1.0.0-beta.9). Manual.
- [ ] Pin the recursive verifier: `node scripts/check-recursive-verifier-vk.mjs --write`. Manual, after review.
- [ ] Publish the signed manifest: `VK_MANIFEST_SIGNING_KEY=<jwk> node scripts/vk-rotate.mjs publish --vk-hash … --vk-version … --grace-hours …`
- [ ] Deploy the PWA so it picks up the new manifest. Old assets must not be served after the grace window.
- [ ] Upgrade the Soroban `vk_hash` (contract upgrade). Manual. The contract code for `vk_hash` is not in this repo.
- [ ] Gate: `node scripts/vk-rotate.mjs check --onchain 0x…` must exit 0. Rotation is not complete until it does.
- [ ] Verify all layers accept new proofs and reject old ones. Manual rehearsal, not yet done.

Not done by the tooling above: a single command that compiles and deploys
everything, and a timed rehearsal. Both still need a human-run spike.

### Recursive verifier inner VK pin (#938)

The recursive verifier pins the inner `responder_credential` verification key
as its public `inner_vk_hash`. CI enforces that pin:

- `.github/workflows/recursive-verifier-vk.yml` recompiles the circuits
  (`circuits/recursive_verifier/build.sh`, nargo 1.0.0-beta.9). It fails if the
  rebuilt `responder_credential` artifact is not byte-identical to the tracked
  one, which makes the recompile reproducible.
- `scripts/check-recursive-verifier-vk.mjs` recomputes the inner VK hash with the
  app's own `createAggregationProver().innerVk()` path and compares it with
  `circuits/recursive_verifier/inner-vk.json`. On drift it prints both hashes.
  While the pin is `null` it fails closed.

To re-pin after an intentional, reviewed circuit change, run the build locally
on the pinned toolchain, then `node scripts/check-recursive-verifier-vk.mjs --write`,
and commit the pin file with the circuit change. The pin is the same
`inner_vk_hash` the rotation checklist above requires every verifier to match.
The HP-014 pin numbering is not defined in this repository. The `crypto-pins.json`
(#779) entries are the machine-readable pins for the proving stack.

**ISP-051 status:**
- Done in code (not yet wired into the live proof path): manifest supersession
  tracking, PWA VK negotiation (`negotiateVk`), fail-closed mismatch handling,
  and offline grace with signed expiry (`src/lib/vkManifest.js`, `scripts/vk-rotate.mjs`).
- Open: pin `VK_MANIFEST_PUBLIC_KEY_JWK`; call `negotiateVk` before the PWA trusts a
  cached VK; persist the held VK identity alongside the cached circuit; hot-reload the
  server VK (the server still needs a restart); the on-chain `vk_hash` upgrade.
