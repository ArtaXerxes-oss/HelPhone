# Contract integration tests

Exercises `src/lib/contract.js`'s on-chain calls against a **real** local Soroban
standalone network, rather than the Vitest unit suite's MSW-mocked network layer
(`test/`, `src/mocks/`). This confirms frontend transactions actually succeed against
localized blockchain state, not just against a JSON-shaped fake.

## Running

Requires Docker and the [Stellar CLI](https://developers.stellar.org/docs/tools/cli)
(`stellar`, formerly `soroban-cli`) installed locally. Neither is available in the
environment this change was authored in, so this suite has **not** been executed as
part of this change — the scripts and test file are written against the documented
`stellar contract build`/`deploy` workflow already used for testnet deploys in
`soroban-contract.md`, but should be run and adjusted against a real Docker+CLI
environment before being relied on in CI.

```bash
# 1. Start the local standalone network (stellar/quickstart Docker image)
scripts/soroban-local-node.sh up

# 2. Build + deploy contract/contracts/helphone-contract to it, writing
#    tests/integration/.local-deployment.json for the test file to read
scripts/deploy-local-contract.sh

# 3. Run the suite (plain node:test, not Vitest — needs a real network stack)
node --test tests/integration/contract.integration.test.js

# 4. Tear down
scripts/soroban-local-node.sh down
```

`tests/integration/.local-deployment.json` is generated per-run and gitignored — it
holds a locally-funded test keypair's secret key, which only has value on the
throwaway local standalone network and must never be committed.

## Why this is separate from `npm test`

`vite.config.js`'s Vitest config only picks up `test/**/*.test.{js,jsx}` — this suite
lives under `tests/integration/` and runs via plain `node --test` instead, since it
needs Docker + a live RPC endpoint rather than jsdom. It's meant to be run explicitly
(locally, or as a distinct opt-in CI job) rather than on every `npm test` invocation.
