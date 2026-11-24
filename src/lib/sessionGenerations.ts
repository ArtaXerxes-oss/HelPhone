/**
 * Session generation ledger (ISP-058 / #728, #922, #923).
 *
 * Every cross-device session has exactly one dispatchable holder: the device
 * that owns the highest generation for that session. Generations only move
 * forward. The ledger refuses a claim from any device that is not that
 * holder, which closes both the "stale source keeps dispatching after a
 * transfer" path and the "two devices present the same generation" split
 * brain.
 *
 * The ledger is process-local. Cluster-wide single-winner enforcement
 * (heartbeat carries generation, replicated tiebreak) is still tracked in
 * `docs/spikes/728-session-transfer-report.md` section 4.
 */

import type { SessionIdentity } from './sessionKey';

/** How long a superseded generation may still drain its outbox without new claims. */
export const DRAIN_GRACE_MS = 15 * 60 * 1000;

export type GenerationRefusal =
  | 'unknown_session'
  | 'stale_generation'
  | 'generation_revoked'
  | 'split_brain'
  | 'future_generation';

export type ClaimResult = { ok: true } | { ok: false; error: GenerationRefusal };

export type DrainResult =
  | { ok: true; mode: 'full' | 'drain-only' }
  | { ok: false; error: GenerationRefusal };

export type PromotionResult =
  | { ok: true; sessionId: string; generation: number; deviceId: string }
  | { ok: false; error: GenerationRefusal };

interface Holder {
  generation: number;
  deviceId: string;
}

interface Ledger {
  /** Highest generation ever minted or registered for the session. */
  highest: number;
  /** The single device allowed to accept new claims, if any. */
  active: Holder | null;
  /** Superseded or revoked generations, with the time they stopped being active. */
  revoked: Map<number, number>;
}

const ledgers = new Map<string, Ledger>();

function ledgerFor(sessionId: string, fallbackHighest: number): Ledger {
  let ledger = ledgers.get(sessionId);
  if (!ledger) {
    ledger = { highest: fallbackHighest, active: null, revoked: new Map() };
    ledgers.set(sessionId, ledger);
  }
  return ledger;
}

/** Retire the current holder (if any). Its generation can no longer accept claims. */
function supersede(ledger: Ledger, now: number): void {
  if (ledger.active) {
    ledger.revoked.set(ledger.active.generation, now);
    ledger.active = null;
  }
}

/**
 * Register a device as the live holder of its generation. This is the
 * generic claim path: it only succeeds for the current highest generation,
 * and only for the device already holding it (or for the first registration).
 * New generations are minted exclusively by `promoteRedeemedTicket` and
 * `mintRestoredGeneration`, never by a bare claim.
 */
export function claimGeneration(identity: SessionIdentity): ClaimResult {
  const ledger = ledgers.get(identity.sessionId);
  if (!ledger) {
    ledgers.set(identity.sessionId, {
      highest: identity.generation,
      active: { generation: identity.generation, deviceId: identity.deviceId },
      revoked: new Map(),
    });
    return { ok: true };
  }
  if (ledger.revoked.has(identity.generation)) return { ok: false, error: 'generation_revoked' };
  if (identity.generation < ledger.highest) return { ok: false, error: 'stale_generation' };
  if (identity.generation > ledger.highest) return { ok: false, error: 'future_generation' };
  if (ledger.active && ledger.active.generation === identity.generation) {
    if (ledger.active.deviceId === identity.deviceId) return { ok: true };
    return { ok: false, error: 'split_brain' };
  }
  return { ok: false, error: 'generation_revoked' };
}

/**
 * Accept a transfer ticket redemption (see `redeemTransferTicket`). The
 * redeemed generation must be exactly one above the highest known for the
 * session, so a second redemption of a ticket minted at the same generation
 * loses the race.
 */
export function promoteRedeemedTicket(
  redeemed: { sessionId: string; generation: number; deviceId: string },
  now: number = Date.now(),
): PromotionResult {
  const ledger = ledgerFor(redeemed.sessionId, redeemed.generation - 1);
  if (redeemed.generation <= ledger.highest) return { ok: false, error: 'stale_generation' };
  if (redeemed.generation > ledger.highest + 1) return { ok: false, error: 'future_generation' };
  supersede(ledger, now);
  ledger.highest = redeemed.generation;
  ledger.active = { generation: redeemed.generation, deviceId: redeemed.deviceId };
  return { ok: true, sessionId: redeemed.sessionId, generation: redeemed.generation, deviceId: redeemed.deviceId };
}

/**
 * Mint a fresh generation after a key-backup restore. It is always strictly
 * above both the highest generation this ledger has seen and the generation
 * recorded in the backup, so a stale backup can never resurrect a revoked
 * generation. Superseding the current holder is intentional: a restore moves
 * the key to the restoring device.
 */
export function mintRestoredGeneration(
  request: { sessionId: string; backupGeneration: number; deviceId: string },
  now: number = Date.now(),
): PromotionResult {
  if (!Number.isInteger(request.backupGeneration) || request.backupGeneration < 0) {
    return { ok: false, error: 'stale_generation' };
  }
  const ledger = ledgerFor(request.sessionId, -1);
  const generation = Math.max(ledger.highest, request.backupGeneration) + 1;
  supersede(ledger, now);
  ledger.highest = generation;
  ledger.active = { generation, deviceId: request.deviceId };
  return { ok: true, sessionId: request.sessionId, generation, deviceId: request.deviceId };
}

/** Explicitly revoke a generation (for example after a reported compromise). */
export function revokeGeneration(sessionId: string, generation: number, now: number = Date.now()): void {
  const ledger = ledgers.get(sessionId);
  if (!ledger) return;
  ledger.revoked.set(generation, now);
  if (ledger.active && ledger.active.generation === generation) ledger.active = null;
}

/**
 * Gate for NEW claims: intents that accept work, enqueue a new outbox write,
 * or otherwise create state. Only the live holder passes.
 */
export function admitClaim(identity: SessionIdentity): ClaimResult {
  const ledger = ledgers.get(identity.sessionId);
  if (!ledger) return { ok: false, error: 'unknown_session' };
  if (ledger.revoked.has(identity.generation)) return { ok: false, error: 'generation_revoked' };
  if (identity.generation < ledger.highest) return { ok: false, error: 'stale_generation' };
  if (identity.generation > ledger.highest) return { ok: false, error: 'future_generation' };
  if (ledger.active && ledger.active.generation === identity.generation) {
    return ledger.active.deviceId === identity.deviceId ? { ok: true } : { ok: false, error: 'split_brain' };
  }
  return { ok: false, error: 'generation_revoked' };
}

/**
 * Gate for draining EXISTING outbox entries. The live holder drains in full.
 * A superseded generation may drain for `DRAIN_GRACE_MS` after it was retired,
 * but only without new claims. A device that presents the live generation
 * under a different device id is a split brain and drains nothing.
 */
export function admitDrain(identity: SessionIdentity, now: number = Date.now()): DrainResult {
  const ledger = ledgers.get(identity.sessionId);
  if (!ledger) return { ok: false, error: 'unknown_session' };
  if (ledger.active && ledger.active.generation === identity.generation) {
    return ledger.active.deviceId === identity.deviceId
      ? { ok: true, mode: 'full' }
      : { ok: false, error: 'split_brain' };
  }
  const retiredAt = ledger.revoked.get(identity.generation);
  if (retiredAt !== undefined && now - retiredAt <= DRAIN_GRACE_MS) {
    return { ok: true, mode: 'drain-only' };
  }
  if (identity.generation > ledger.highest) return { ok: false, error: 'future_generation' };
  return { ok: false, error: retiredAt !== undefined ? 'stale_generation' : 'generation_revoked' };
}

/** Test hook: forget every session so suites start from a clean slate. */
export function __resetSessionGenerationsForTests(): void {
  ledgers.clear();
}
