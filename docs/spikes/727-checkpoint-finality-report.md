# Spike #727: ZK Checkpoint Ledger-Reorg Finality — Explicit Tiers

Refs [#727](https://github.com/Hel-Phone/HelPhone/issues/727).

## 1. Executive Summary

The issue reports that the indexer treats first-sight of a `CheckpointCommitted`
event as final, releasing aid and firing webhooks pre-finality, with no orphan
handling on reorg. Against current `main`, `server/indexer/parser.ts` handles
only `created/accepted/arrived/resolved` (+ federated) events — there is no
`CheckpointCommitted` branch and no checkpoint table projection — while
`server/indexer/exporter.ts` is a Soroban contract-state snapshot exporter, not
a checkpoint projector. `src/lib/contract.ts` has checkpoint submission (auth
error at the "record the checkpoint" path), but no depth tracking exists
anywhere downstream.

This spike ships the classification core the whole design hangs on: an
explicit finality-tier module (`server/lib/finality.ts`) so no layer can
again conflate "seen" with "final", plus the orphan predicate for reorg-aware
projection. Tests cover the tier boundaries and both reorg directions.

## 2. Tiers Shipped

| Tier | Meaning | Automation allowed |
|---|---|---|
| `pending` | depth 0, first sight | none (informational) |
| `closed` | 0 < depth < k | informational webhook only |
| `finalized` | depth ≥ k (default k=2) | aid release, chained submissions |
| `orphaned` | same ledger reseen at a different hash | compensating events, never silent delete |

- `classifyFinality(depth, { finalityDepth })` — throws on negative/NaN depth
  (a caller passing garbage must never receive a tier that gates aid release).
- `isOrphaned(first, latest)` — same-ledger/different-hash only; distinct
  ledgers are distinct events.

## 3. Decision: Fixed k=2 Default, Adaptive Later

Exp 1 (finality-gap measurement across RPC nodes) and Exp 3 (adaptive depth
during `rpcHealth` degradation) need multi-node instrumentation that does not
exist in this codebase yet. The module takes `finalityDepth` as an option so
the indexer can raise k when RPC health degrades, per the issue's adaptive
finality AC, without changing call sites.

## 4. Remaining Work (out of scope of this PR)

- `CheckpointCommitted` parsing + `pending|closed|finalized|orphaned` column
  in the checkpoint projection with watermark rewind (Exp 2).
- `auditStreamer.js` compensating `checkpoint.orphaned` events; exactly-once
  finalized stream under restart replay.
- Help.jsx / CommunityMap three-state UI; aid-release gate on `finalized`.
- Prover auto-rebase to the current finalized root (`GET /api/zk/finalized-root`).
- Stellar Expert links rendered with ledger hash + tier.
- Life-safety quorum override path, fully audit-logged.
