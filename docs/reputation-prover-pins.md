# Reputation prover pins (#772, #945)

`package.json` and `crypto-pins.json` pin `@aztec/bb.js` (`0.87.9`) and `@noir-lang/noir_js` (`1.0.0-beta.9`).
They must remain aligned with:
- `circuits/reputation/Nargo.toml` (`compiler_version = ">=0.36.0"`)
- `public/config.json` (`flags.reputationGatedRanking.generation = 1`)
- `src/lib/rankingIntegrity.ts` (`EXPECTED_REPUTATION_PINS`)

## Verification

- **At boot**: `bootReputationPinCheck()` runs in `src/main.tsx`. If the circuit compiler version, prover pins, or ranking flag generation disagree, `proven`-tier ranking is automatically disabled and responders degrade to `probationary` labels.
- **In CI**: `node scripts/check-reputation-pins.js` (`npm run security:reputation-pins`) runs in `.github/workflows/ci.yml` and fails the build if any of the four sources drift.
- **Flag Governance & Staged Rollout (#944)**: `node scripts/audit-feature-flags.js --check` (`npm run security:flag-audit`) verifies flag ownership, `expiresAt` freshness, `canaryStage` alignment, and `auditLog` actor/reason records. Promoting `reputationGatedRanking` or `experimental_zk_v2` must follow `off -> canary_10 -> canary_50 -> ga_100` and fails if prover pins are misaligned.

## Rollback

To disable reputation-gated ranking in production without a code deploy, set `flags.reputationGatedRanking.enabled` to `false` in `public/config.json`.
