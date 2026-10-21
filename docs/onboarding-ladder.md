# Onboarding Ladder — HelPhone

This document defines the four-stage curriculum for new contributors. Each
stage has a time-box, a concrete task, an expected output, and a gate that
must pass before moving to the next stage.

**Goal:** A competent generalist can clone the repo, make a safe reviewed
contribution, and merge it within 24 hours. The ladder defines what "safe"
means per subsystem and what must be demonstrated before touching progressively
critical paths.

Start here: clone the repo, copy `.env.example` to `.env`, and open this file.

---

## Stage 0 — Toolchain Green (time-box: 30 minutes)

**Goal:** The toolchain is running and producing a green test suite on a fresh
clone. No prior knowledge of HelPhone's codebase is required to complete this stage.

### Steps

```bash
git clone https://github.com/Hel-Phone/HelPhone.git
cd HelPhone

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Fill in VITE_MAPBOX_TOKEN (get a free token at https://account.mapbox.com/)
# Leave VITE_AEGIS_VAULT_ID and VITE_ZK_PROVER_URL as defaults for now

# Run the type-checker
npm run typecheck
# Expected: 0 errors

# Run the linter
npm run lint
# Expected: 0 errors (warnings are acceptable)

# Run the test suite
npm test
# Expected: all tests pass (some tests are marked .skip for optional infra)

# Start the dev server
npm run dev
# Expected: browser opens at http://localhost:3000
```

### Expected outputs

- [ ] `npm test` exits 0 with ≥90% of tests passing in under 5 minutes.
- [ ] Dev server starts and the landing page renders without console errors.
- [ ] TypeScript reports 0 errors.
- [ ] Lint reports 0 errors.

### Stall guide

| Error | Fix |
|---|---|
| `VITE_MAPBOX_TOKEN` map blank | Set token in `.env` from https://account.mapbox.com |
| `tsc: Cannot find module` | Run `npm install` again; check `node --version` ≥ 18 |
| `ESLint: Cannot find config` | Run from repo root, not a subdirectory |
| Postgres connection refused | Map-only mode works without DB; skip if just exploring |
| Husky hook fails on first commit | See `.husky/commit-msg` for signing setup instructions |

---

## Stage 1 — UI Spike (time-box: 4 hours)

**Goal:** Make a visible, test-verified change to the UI that goes through the
full review cycle: branch → commit → PR → review → merge.

**Safe zone:** `src/App.tsx`, `src/pages/Ranking.tsx`, `src/styles/`,
`src/components/` (non-critical components like `Breadcrumb.jsx`, `LanguageSwitcher.tsx`).

**Not yet:** `src/lib/contract.ts`, `src/lib/footprint.ts`, `contracts/`,
`server/db/` — those require Stage 3.

### Fixture task

Pick one of the labeled first-spike tasks from `TODO.md` with
`difficulty: beginner` and `mentor: <handle>`. Suggested tasks:

- Add a missing `aria-label` to a UI control (see `tests/e2e/a11y.spec.ts` for coverage gaps).
- Fix a layout overflow detected by the layout matrix (see `tests/e2e/layout.spec.ts`).
- Add or improve a snapshot test in `test/snapshots.test.jsx`.

### Steps

```bash
git checkout -b spike/your-name-brief-description

# Make your change in src/
# Run the relevant tests
npm test -- --reporter=verbose

# If you added a visual change, regenerate the snapshot
npm run test:layout:generate

# Commit (will trigger pre-commit gate)
git add src/
git commit -m "fix: add aria-label to request type selector"

# Push and open a PR
git push -u origin spike/your-name-brief-description
```

### Expected outputs

- [ ] A PR is open against `main` with a description explaining the change.
- [ ] CI passes (all green checks).
- [ ] At least one existing test was updated or a new test was added.
- [ ] A CODEOWNERS-listed reviewer has approved the PR.
- [ ] PR merged within 4 hours of review request.

### Gate criteria

Reviewer checks:
- The change is self-contained: it does not touch contract or DB paths.
- Tests cover the change.
- No new lint or type errors introduced.

---

## Stage 2 — API Spike (time-box: 8 hours)

**Goal:** Add or extend a documented, tested server-side endpoint. This stage
introduces `server/routes/`, `swagger.json`, and the server test harness.

**Safe zone:** `server/routes/health.ts`, `server/routes/history.ts`,
`server/routes/events.ts`, `server/routes/docs.ts`.

**Not yet:** `server/routes/dispatch.ts` (life-safety routing), `server/db/`
(migration paths) — those require Stage 3.

### Fixture task

Pick a labeled first-spike task with `difficulty: intermediate` from `TODO.md`.
Suggested:

- Add a documented `/api/version` endpoint that returns the server version and
  Stellar network name. Add it to `swagger.json`. Write a test in `test/server-api.test.js`.
- Label an existing route in `server/routes/docs.ts` with its life-safety
  classification (see ADR-020 for the priority tier vocabulary).

### Steps

```bash
git checkout -b spike/your-name-api-change

# Add the route in server/routes/
# Update swagger.json
# Add a test in test/server-api.test.js
npm test -- test/server-api.test.js

# Verify swagger is valid
cat swagger.json | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{JSON.parse(d); console.log('valid JSON')})"

git add server/ swagger.json test/
git commit -m "feat: add /api/version endpoint"
git push -u origin spike/your-name-api-change
```

### Expected outputs

- [ ] New endpoint documented in `swagger.json`.
- [ ] Test passes covering both success and error cases.
- [ ] CI passes.
- [ ] CODEOWNERS reviewer has approved.

### Gate criteria

Reviewer checks:
- Route is idempotent and read-only (no writes in Stage 2).
- Input validation present on any URL params or query strings.
- No direct DB queries bypassing `server/db/connection.ts` wrapper.

---

## Stage 3 — Indexer / Contract Sandbox Spike (time-box: 16 hours)

**Goal:** Make a verified change to a Soroban contract, the indexer, or the
database layer — in the local Stellar sandbox. No testnet deploy yet.

**Prerequisites:** Complete Stage 2 and read:
- `docs/adr/ADR-001-soroban-incident-storage.md` (storage cost fundamentals)
- `docs/soroban-footprints.md` (footprint budget)
- `docs/review-policy.md#contracts` and `docs/review-policy.md#database` (review checklists)

### Fixture task

Pick a labeled first-spike task with `difficulty: advanced` from `TODO.md`.
Suggested:

- Add a unit test to `contracts/helphone_dao/src/test.rs` that verifies the
  `teaching_bps` field arithmetic from ADR-015 (once implemented).
- Add a `withTenant` call to an existing query in `server/db/connection.ts`
  (ADR-017 prerequisite work).
- Run the full indexer pipeline locally:
  ```bash
  bash scripts/soroban-local-node.sh
  # Deploy the contract to the local node
  bash scripts/deploy-local-contract.sh
  # Run the indexer
  cd server && npx ts-node indexer/daemon.ts
  ```

### Expected outputs

- [ ] Local Stellar node started via `scripts/soroban-local-node.sh`.
- [ ] Contract deployed locally via `scripts/deploy-local-contract.sh`.
- [ ] Change passes `cargo test` in the relevant contract workspace.
- [ ] If a DB change: migration authored, tested against local Postgres.
- [ ] Change reviewed by the CODEOWNERS contract or DB owner.

### Gate criteria

Reviewer checks (full `docs/review-policy.md#contracts` checklist applies):
- No storage key schema changes without migration path.
- Footprint budget verified.
- Testnet deploy is NOT required for Stage 3 — mentor signs off on the
  sandbox test as sufficient for the spike.

---

## Graduation — Backup Reviewer Qualification

To become a named backup reviewer for a subsystem (required before a team
member can independently approve PRs in that subsystem):

1. Complete all three previous stages in the relevant subsystem.
2. Successfully execute the subsystem's **graduation drill** (see
   `docs/first-spike-program.md#graduation-drills`).
3. Have at least one PR in that subsystem reviewed with the primary owner's
   explicit sign-off on the quality of your review.
4. Be added to `docs/bus-factor-ledger.md` as the named backup with a date.

Graduation drills are live exercises, not quizzes. Examples:

- **ZK track:** Perform an `aegis_vault` ZK rotation drill: generate a new
  proving key, update `src/wasm/`, verify all existing proofs still pass.
- **Contract track:** Execute a storage migration on testnet, verify no
  live requests were affected, run `scripts/export-contract-state.sh` before
  and after.
- **DB track:** Simulate a pool exhaustion event in staging, diagnose via
  `server/db/poolManager.ts` metrics, and restore service.

---

## Quick reference

| Stage | Time-box | Safe zone | Gate |
|---|---|---|---|
| 0 — Toolchain Green | 30 min | N/A | npm test passes |
| 1 — UI Spike | 4 h | src/App.tsx, src/pages/, src/styles/ | PR reviewed + merged |
| 2 — API Spike | 8 h | server/routes/ (read-only), swagger.json | PR reviewed + merged |
| 3 — Contract/Indexer | 16 h | contracts/, server/db/, server/indexer/ | Mentor sign-off + sandbox tests pass |
| Graduation | varies | Full subsystem | Live drill passed |

See `AGENTS.md` for the quick-start dev loop and `TODO.md` for the labeled
first-spike backlog.
