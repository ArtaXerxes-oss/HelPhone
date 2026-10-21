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
 * The indexer keeps orphaned siblings (marked, never deleted) and rewinds its
 * watermark; the full reorg-aware projection design is specced in
 * `docs/spikes/727-checkpoint-finality-report.md`.
 */

export type FinalityTier = 'pending' | 'closed' | 'finalized' | 'orphaned';

export const DEFAULT_FINALITY_DEPTH = 2;

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
