/**
 * Checkpoint finality tiers (ISP-057 / #727).
 *
 * Stellar closes ledgers ~every 5s, but a close is not irreversible finality.
 * This module classifies a sighting by ledger depth so no layer treats
 * first-sight as final:
 *
 *   pending   — depth 0, just observed (reversible, informational only)
 *   closed    — depth > 0 but below the finality depth k (still reversible)
 *   finalized — depth >= k (k-deep; aid release / chained submissions gate here)
 *   orphaned  — a later sighting of the same ledger at a different ledger hash
 *
 * Issue #919: When RPC health degrades the finality depth k is raised so that
 * the prover waits for more confirmations before treating a checkpoint as final.
 * This prevents a split-brain during RPC instability from releasing aid against
 * a ledger that the network later orphans.
 *
 * The indexer keeps orphaned siblings (marked, never deleted) and rewinds its
 * watermark; the full reorg-aware projection design is specced in
 * `docs/spikes/727-checkpoint-finality-report.md`.
 */

import type { NetworkQuality } from '../../src/types/index.js'

export type FinalityTier = 'pending' | 'closed' | 'finalized' | 'orphaned';

export const DEFAULT_FINALITY_DEPTH = 2;

/** k values per RPC quality tier (issue #919 — adaptive finality depth). */
export const FINALITY_DEPTH_BY_QUALITY: Record<NetworkQuality, number> = {
  good:     2,  // nominal — standard 2-ledger confirmation
  degraded: 4,  // double confirmation while RPC is unreliable
  offline:  8,  // maximum caution; indexer should pause new submissions
  unknown:  4,  // conservative default until a probe result arrives
};

/**
 * Return the adaptive finality depth k for the current RPC health quality.
 * Call-sites that already accept `FinalityOptions.finalityDepth` need no
 * changes — they receive the computed k and remain oblivious to RPC state.
 */
export function adaptiveFinalityDepth(quality: NetworkQuality): number {
  return FINALITY_DEPTH_BY_QUALITY[quality] ?? DEFAULT_FINALITY_DEPTH;
}

// ── Finalized-root registry ────────────────────────────────────────────────────

export interface FinalizedRoot {
  /** Stellar ledger sequence number of the last k-confirmed ledger. */
  ledger: number;
  /** Ledger hash of that ledger (the value circuits commit to). */
  ledgerHash: string;
  /** ISO-8601 timestamp when this root was recorded. */
  recordedAt: string;
  /** The k value that was active when this root was confirmed. */
  finalityDepth: number;
}

let _finalizedRoot: FinalizedRoot | null = null;

/**
 * Return the most recently recorded finalized root, or null if none has been
 * confirmed yet (e.g. indexer has not yet reached depth k from genesis).
 */
export function getFinalizedRoot(): FinalizedRoot | null {
  return _finalizedRoot;
}

/**
 * Record a new finalized root.  Called by the indexer once a sighting reaches
 * depth k.  The prover reads this via `GET /api/zk/finalized-root` to rebase
 * its circuit inputs onto the latest confirmed checkpoint.
 */
export function updateFinalizedRoot(root: Omit<FinalizedRoot, 'recordedAt'>): FinalizedRoot {
  _finalizedRoot = { ...root, recordedAt: new Date().toISOString() };
  return _finalizedRoot;
}

/** Test hook: reset the finalized root to null. */
export function __resetFinalizedRoot(): void {
  _finalizedRoot = null;
}

export interface FinalityOptions {
  /** Depth k at which a sighting becomes finalized. Defaults to 2. */
  finalityDepth?: number;
}

export interface LedgerSighting {
  ledger: number;
  ledgerHash: string;
}

/**
 * Classify a sighting by how many ledgers deep it is behind the observed tip.
 * Throws on negative or non-numeric depths — a caller passing garbage must
 * not silently receive a tier that gates aid release.
 */
export function classifyFinality(ledgerDepth: number, options: FinalityOptions = {}): FinalityTier {
  const depth = Number(ledgerDepth);
  if (!Number.isFinite(depth) || depth < 0) {
    throw new RangeError(`ledgerDepth must be a non-negative number, got ${String(ledgerDepth)}`);
  }
  const k = options.finalityDepth ?? DEFAULT_FINALITY_DEPTH;
  if (depth <= 0) return 'pending';
  return depth >= k ? 'finalized' : 'closed';
}

/**
 * A sighting is orphaned when the same ledger is later observed at a
 * different ledger hash (reorg or RPC divergence). Different-ledger
 * sightings are distinct events, not orphans.
 */
export function isOrphaned(first: LedgerSighting, latest: LedgerSighting): boolean {
  return first.ledger === latest.ledger && first.ledgerHash !== latest.ledgerHash;
}
