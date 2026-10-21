# Reputation prover pins (#772)

`package.json` pins `@aztec/bb.js` and `@noir-lang/noir_js`.
Keep them aligned with `circuits/reputation/Nargo.toml` before enabling `reputationGatedRanking` in production.
Rollback: set the flag to false in `public/config.json`.
