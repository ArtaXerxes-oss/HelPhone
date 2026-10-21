# AGENTS.md – HelPhone

## What This Repo Is

A **React + Vite application** for HelPhone, a community emergency response web
app built on Stellar. Full dev workflow with hot reload support. Emergency
requests, ZK location proofs, Soroban smart contracts, WebAuthn Passkeys, and
automated contract storage backups.

## Quick Start (Stage 0 of the onboarding ladder)

```bash
npm install          # Install dependencies
cp .env.example .env # Fill in VITE_MAPBOX_TOKEN at minimum (see .env.example)
npm run dev          # Start local dev server → http://localhost:3000
npm run typecheck    # TypeScript type check (0 errors expected)
npm run lint         # ESLint (0 errors expected)
npm test             # Full Vitest test suite
```

**Target:** `npm test` passes in under 5 minutes on a fresh clone. If it takes
longer or fails, that is a bug in the onboarding experience — file a task in
`TODO.md`.

## First-Spike Backlog (where to start contributing)

Labeled tasks in `TODO.md` are safe first contributions. Each task has:

- `difficulty: beginner | intermediate | advanced`
- `mentor: @handle` — the named mentor for this task
- `demo-slot: YYYY-QN` — the monthly demo slot to present when complete
- `subsystem` and `ladder` stage (1, 2, or 3)

**Start with a `difficulty: beginner` task.** These are Stage 1 (UI) tasks that
do not touch contracts, database, or ZK code.

See `docs/onboarding-ladder.md` for the full four-stage curriculum.

## Onboarding Ladder

| Stage | Goal | Time-box | Entry path |
|---|---|---|---|
| 0 — Toolchain Green | `npm test` passes on fresh clone | 30 min | This file → `.env.example` |
| 1 — UI Spike | Merged PR to `src/` | 4 h | `TODO.md` beginner tasks |
| 2 — API Spike | Merged PR to `server/routes/` | 8 h | `TODO.md` intermediate tasks |
| 3 — Contract/Indexer | Sandbox deploy + merged PR | 16 h | `TODO.md` advanced tasks + mentor pairing |

Full details: `docs/onboarding-ladder.md`

## Stack

- **Framework**: React 18 + TypeScript
- **Build**: Vite
- **Dev Server**: `npm run dev` → http://localhost:3000
- **Package Manager**: npm
- **Node**: v18+ required (v22 recommended, matches CI)
- **Rust**: required for Soroban contracts (`contracts/`, `contract/`)
- **Noir**: required for ZK circuits (`circuits/`)

## Build & Test Commands

```bash
npm run dev          # Vite dev server with hot reload
npm run build        # Production build → dist/
npm run preview      # Preview production build
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .
npm test             # Full Vitest suite
npm run test:layout  # Playwright multi-resolution layout matrix
npm run export:state # Export Soroban contract state to snapshots/
```

## File Organisation

### Source Code

- **`src/App.tsx`** — App router and top-level layout
- **`src/pages/`** — Page components (Help, Ranking, Admin, Kiosk, VaultDashboard)
- **`src/components/`** — Shared components (CommunityMap, WebGPUMap, TreasuryPanel…)
- **`src/lib/`** — Core libraries (contract.ts, zk.ts, crypto.ts, footprint.ts…)
- **`src/services/`** — Service layer (api.ts, zkProver.ts, crdtSync.js…)
- **`src/workers/`** — Web Workers (zk-worker.js, telemetryWorker.js, canvas-worker.js)
- **`src/lib/footprint.ts`** — Soroban storage footprint budgeting (**do not touch until Stage 3**)
- **`src/lib/contract.ts`** — Soroban contract bindings (**do not touch until Stage 3**)

### Server

- **`server/routes/`** — Express route handlers
- **`server/db/`** — Postgres pool, migrator, partitioning
- **`server/indexer/`** — Soroban event indexer daemon
- **`server/middleware/`** — Auth, CSP, CORS, compression…

### Contracts & Circuits

- **`contracts/`** — Soroban Rust contracts (aegis_vault, helphone_dao, emergency_vault, maintainer_vault)
- **`circuits/`** — Noir ZK circuits (location proof, responder credential)

### Scripts & Config

- **`scripts/`** — ~20 sharp tools. Start with `scripts/soroban-local-node.sh` (Stage 3).
- **`docs/adr/`** — Architecture Decision Records (read before touching a subsystem)
- **`.github/CODEOWNERS`** — Path → reviewer mapping (enforced in CI)

## Codeowners & Review Routing

Pull requests touching subsystem paths in `.github/CODEOWNERS` require approval
from the listed expert reviewer. This is enforced by CI — a PR cannot merge
without the required approvals.

For high-stakes subsystems (contracts, ZK, DB migrations), check the review
checklist in `docs/review-policy.md` before requesting review.

## Bus-Factor Status (critical)

4 of 9 subsystems are at bus-factor 1. See `docs/bus-factor-ledger.md` for the
full ledger and mitigation plans. If you are interested in becoming a backup
reviewer for a critical subsystem, start with the first-spike program
(`docs/first-spike-program.md`).

## Environment Variables

See `.env.example` for the full annotated list. Minimum for local dev:

```bash
VITE_MAPBOX_TOKEN=pk.eyJ1...  # Get free token at https://account.mapbox.com/
NODE_ENV=development
PORT=3001
DATABASE_URL=postgresql://user:password@localhost:5432/helphone
```

## Gotchas

1. **Asset paths**: Use relative paths (`assets/hero-nokia.mp4`), not `/assets/...`
2. **Pre-commit hooks**: Husky runs lint + typecheck on commit. See `.husky/pre-commit` for fix instructions if it fails.
3. **Scroll reveal race condition**: Fallback timeout after 4.5s ensures reveals show even if observer fails.
4. **ZK proving**: `src/lib/zk.ts` generating proofs in tests requires `VITE_ZK_PROVER_URL` — defaults to `/zk` which is the local server.
5. **Soroban contracts**: Never touch `src/lib/footprint.ts` or `contracts/` without Stage 3 onboarding and a named mentor.

## Design Tokens

Colors in `src/styles/theme.css`:
- **Primary teal**: `#234B4E`
- **Accent coral**: `#FF7A6B` (CTAs, emergency indicators)
- **Purple**: `#7357FF` (community/responders)
- **Cream bg**: `#ECE0CC`
- **Dark bg**: `#1c2c24`

## Quarterly Refresh Ownership

The following items are reviewed each quarter (January, April, July, October):

| Item | Owner | Docs |
|---|---|---|
| Bus-factor ledger | `@helphone-maintainers` | `docs/bus-factor-ledger.md` |
| CODEOWNERS + review policy | `@helphone-maintainers` | `.github/CODEOWNERS`, `docs/review-policy.md` |
| First-spike conversion metric | `@helphone-maintainers` | `docs/first-spike-program.md` |
| Monthly demo slot scheduling | `@helphone-maintainers` | `docs/first-spike-program.md#demo-ritual` |
| ADR index — any expired deferrals | `@helphone-maintainers` | `docs/adr/README.md` |
