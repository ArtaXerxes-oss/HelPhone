# Quarterly CODEOWNERS Refresh Checklist (2026-Q4)

Generated from `docs/bus-factor-ledger.md`, `.github/CODEOWNERS`, and `config/maintainer-keys.json` (#953).

## Sign-Off Record

| Field | Value |
|---|---|
| Quarter | 2026-Q4 |
| Signed off at | 2026-10-16T00:00:00Z |
| Expires at | 2027-01-16T00:00:00Z |
| Signers | @helphone-security-owner, @helphone-maintainers |
| Key ceremony threshold | 2-of-3 |
| Next ceremony due | 2027-01-16T00:00:00Z |

## Bus-Factor-1 Subsystems (Dated Drills Required)

| Subsystem | Primary Owner | Named Backup | Drill Target Date | Graduation Drill |
|---|---|---|---|---|
| Soroban Contracts | @helphone-contract-owner | *VACANT* | 2027-Q1 (hard deadline) | testnet contract upgrade with state migration. Must be executed by the backup candidate before the deadline. |
| Indexer / DB | @helphone-db-owner | *VACANT* | 2027-Q1 (hard deadline) | simulate a lag spike in staging, diagnose, and restore without the primary owner. |
| ZK / Circuits | @helphone-zk-owner | *VACANT* | 2027-Q2 | complete the ADR-016 credential circuit (`circuits/responder_credential/`) independently. |
| Maps / WebGPU | @helphone-maps-owner | *VACANT* | 2027-Q1 | reproduce and fix a GPU-tier fallback regression on the software-rendering path. |
| Telemetry | @helphone-telemetry-owner | *VACANT* | 2027-Q1 | schema migration from FlatBuffers v1 to v2 with backward-compatible reader. |

## High-Stakes Path Gating

| Path | CODEOWNERS |
|---|---|
| `contracts/` | @helphone-contract-owner @helphone-contract-backup |
| `circuits/` | @helphone-zk-owner |
| `server/db/` | @helphone-db-owner @helphone-db-backup |
| `server/middleware/auth.ts` | @helphone-security-owner @helphone-maintainers |
| `config/maintainer-keys.json` | @helphone-security-owner @helphone-maintainers |
| `.github/CODEOWNERS` | @helphone-security-owner @helphone-maintainers |

## Verification

- [x] 2-of-N maintainer key-custody ceremony verified (`npm run security:key-ceremony`)
- [x] Bus-factor-1 subsystems enumerated with dated graduation drills
- [x] High-stakes CODEOWNERS paths verified against `docs/review-policy.md`
