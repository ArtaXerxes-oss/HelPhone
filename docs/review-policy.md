# Review Policy — HelPhone

This document defines the checklists, escalation rules, and SLAs that apply to
pull requests touching the paths mapped in `.github/CODEOWNERS`. It is
referenced directly by CODEOWNERS so reviewers can look up the checklist for
their subsystem without hunting through the wiki.

---

## General principles

1. **Expertise, not availability.** CODEOWNERS routes to knowledge, not to
   whoever has bandwidth. If a listed owner is unavailable, flag the PR rather
   than routing to a generalist who cannot evaluate the risk.
2. **Bus-factor obligation.** When a backup reviewer is listed, they must be
   *capable* of approving alone, not just technically present. If the backup
   cannot explain the change, they must block and call in the primary.
3. **No rubber-stamps.** An approval on a CODEOWNERS-protected path is a
   statement that you understand the change and its consequences. If you cannot
   make that statement, request changes and explain why.
4. **Checklists are floors, not ceilings.** Complete the checklist *and* apply
   judgment. A checklist item that would be harmful to apply in context should
   be noted in the review comment, not silently skipped.

---

## Subsystem checklists

### `contracts` — Soroban Smart Contracts {#contracts}

Applies to: `contracts/`, `contract/`, `src/lib/contract.ts`,
`src/lib/footprint.ts`, `src/lib/txBatcher.ts`, `src/lib/treasury.ts`,
`src/generated/soroban-bindings.ts`.

- [ ] Storage key schema: have any Soroban storage keys changed? If yes, is
      there a migration path that does not brick live ledger entries?
- [ ] Footprint budget: does `src/lib/footprint.ts` correctly declare all read
      and write entries? Run `test/footprint-inspection.test.js` locally.
- [ ] Rent pressure: have storage TTL or rent amounts changed? Review
      `docs/soroban-footprints.md` and the `rentRenewer.ts` schedule.
- [ ] Fee arithmetic: has `fee_bps` or any treasury split changed? Verify
      `sustainability.rs` unit tests pass and the UI display in
      `MaintainerFunding.jsx` reflects the new values.
- [ ] Binding freshness: if the Rust interface changed, have the TypeScript
      bindings been regenerated via `scripts/generate-soroban-bindings.js`?
- [ ] Testnet smoke: has the change been deployed to Stellar testnet and
      manually exercised, or is there a test snapshot in `test_snapshots/`?
- [ ] API drift baseline: if exported contract types changed, has the drift
      baseline in `package.json → apiDrift.baseline` been updated?

### `database` — Indexer & DB Layer {#database}

Applies to: `server/db/`, `server/indexer/`, `migrations/`.

- [ ] Migration order: is the new migration file named with a timestamp that
      places it after all currently applied migrations in `schema_migrations`?
- [ ] Idempotency: does the migration run without error on a database that
      already has the schema (i.e., no `CREATE TABLE` without `IF NOT EXISTS`)?
- [ ] RLS policies: if a new table or column is added, does it carry the
      correct Row-Level Security policy? Check `migrations/20260501000000_tenant_rls.sql`
      as the template.
- [ ] Index impact: has the query plan been checked for the affected tables?
      Review `server/db/indexOptimizer.ts` guidance.
- [ ] Pool budget: does the change introduce any new long-lived connections or
      transactions that could exhaust `poolManager.ts`'s pool ceiling?
- [ ] Rollback path: is there a down-migration or a step-by-step rollback
      documented in `docs/disaster-recovery.md`?
- [ ] Partition key: if `partitioning.js` is touched, has the partition key
      been validated against the data distribution in staging?

### `zk` — ZK Circuits & Provers {#zk}

Applies to: `circuits/`, `src/lib/zk.ts`, `src/lib/provers.js`,
`src/services/zkProver.ts`, `src/workers/zk-worker.js`.

- [ ] Soundness: does the change preserve the ZK property that the prover
      cannot forge a valid proof without a valid witness? Any circuit
      modification requires a written soundness argument in the PR description.
- [ ] Proving-key version: if the circuit structure changed, has the proving
      key been regenerated and committed (or scheduled for regeneration)?
      Version mismatch causes silent proof rejection in production.
- [ ] Nullifier integrity: is `Poseidon2(secret_id, campaign_id)` still the
      sole nullifier construction, with no bypass path added?
- [ ] Privacy regression: does `anonymizeLocation` still coarsen to ≥1 km?
      Does `createRequest` still pass empty name/contact on-chain?
- [ ] Worker compatibility: has `src/workers/zk-worker.js` been updated to
      match any API changes in `src/lib/zk.ts`?
- [ ] Proof cache: has `src/services/zkProofCache.js` cache-key logic been
      updated if the proof inputs changed?
- [ ] Benchmark: for circuit changes, run `circuits/scripts/benchmark.sh` and
      attach the timing comparison to the PR.

### `pwa` — PWA / Offline / Service Worker {#pwa}

Applies to: `src/service-worker.js`, `src/lib/syncManager.ts`,
`src/lib/crdt.ts`, `src/services/crdtSync.js`.

- [ ] Cache invalidation: does the change correctly version or bust the service
      worker cache? Stale assets served during a disaster are a life-safety risk.
- [ ] CRDT convergence: if `src/lib/crdt.ts` is modified, does the state
      converge to the same value regardless of merge order (commutativity,
      associativity, idempotency)? Run `test/crdt-sync.test.js`.
- [ ] Reconnect path: on network recovery, does `syncManager.ts` flush all
      offline-queued mutations in the correct order without duplicates?
- [ ] Background sync: is any new `fetch` call guarded by `navigator.onLine`
      and queued for later if offline?
- [ ] Storage quota: does the change risk hitting `storageEngine.js`'s quota
      budget under the load profile in `test/load-profile.test.js`?

### `maps` — Maps & WebGPU {#maps}

Applies to: `src/components/WebGPUMap.jsx`, `src/shaders/`, `src/lib/offscreenCanvas.ts`.

- [ ] GPU tier coverage: has the change been tested on the software-rendering
      fallback path (set `VITE_FORCE_CANVAS_FALLBACK=1`)?
- [ ] Shader compilation: does the WGSL shader compile without errors on both
      Chromium and Firefox stable? Run `test/spatial-cluster.test.js`.
- [ ] Memory leak: does the OffscreenCanvas worker correctly terminate and
      release GPU buffers on unmount?
- [ ] FPS budget: does the change stay within the 30 FPS floor measured in
      `src/lib/offscreenCanvas.ts`?

### `dispatch` — Dispatch / WebSocket Cluster {#dispatch}

Applies to: `server/routes/dispatch.ts`, `server/routes/wsCluster.js`.

- [ ] Emergency broadcast: is the `RqCreated` message type still prioritized
      over `LocUpd` in the dispatch queue? (See ADR-003.)
- [ ] WS storm protection: does the change introduce any reconnect loop without
      exponential backoff?
- [ ] Redis fan-out: is the new publish pattern bounded (no unbounded
      broadcast amplification)?
- [ ] Graceful degradation: if Redis is unavailable, does dispatch fall back to
      local memory pub/sub without crashing?

### `security` — Security Infrastructure {#security}

Applies to: `server/middleware/auth.ts`, `src/lib/crypto.ts`,
`scripts/security/`, `config/maintainer-keys.json`.

- [ ] Anti-replay window: has the timestamp freshness window in `auth.ts` been
      preserved (currently ±30 s)?
- [ ] Key rotation: if `config/maintainer-keys.json` is modified, has the
      change been coordinated with `scripts/security/verify_maintainer_keys.js`
      and the `verify-keys.yml` CI workflow?
- [ ] No hardcoded secrets: has `scripts/audit-ai-code.js` been run and passed?
- [ ] Crypto primitives: are any new cryptographic operations using the
      primitives already in `src/lib/crypto.ts` rather than ad hoc
      implementations?
- [ ] Supply-chain: if a new dependency is added that touches the security
      path, has it been vetted via `scripts/audit-deps.js` and
      `scripts/detect-typosquatting.js`?

---

## SLAs

| Subsystem | Review SLA | Escalation |
|---|---|---|
| Soroban contracts | 2 business days | Core team sync |
| Database migrations | 1 business day | Immediate for production-blocking |
| ZK circuits | 3 business days | External ZK reviewer if owner unavailable |
| PWA / offline | 2 business days | Core team sync |
| Security | 1 business day | Block merge until resolved |
| All others | 3 business days | @helphone-maintainers |

---

## Backup reviewer qualification

A named backup reviewer is considered qualified when they have:

1. Completed the relevant onboarding ladder stage (see `docs/onboarding-ladder.md`).
2. Successfully executed the subsystem's graduation drill at least once
   (documented in `docs/first-spike-program.md`).
3. Had at least one PR in that subsystem reviewed and merged with the primary
   owner's explicit sign-off on the backup's review quality.

Until all three criteria are met, the person can be listed as a backup in
training but cannot act as the sole approving reviewer.

---

## Quarterly refresh

This policy and CODEOWNERS are reviewed each quarter (January, April, July,
October). The refresh owner is `@helphone-maintainers`. Refresh actions:

1. Verify all named owners are still on the team and available.
2. Confirm all backups have completed their qualification criteria.
3. Update bus-factor counts in `docs/bus-factor-ledger.md`.
4. Graduate any backup who met criteria to co-primary status.
5. Recruit for any subsystem still at bus-factor 1.
