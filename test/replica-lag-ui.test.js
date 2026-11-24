// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  readReplicaLagHeader,
  staleBadgeText,
  requiresDispatchOverride,
  dispatchOverrideMessage,
  REPLICA_LAG_BUDGET_MS,
  SEVERE_REPLICA_LAG_MS,
} from '../src/lib/replicaLag.js';

describe('History lag UI helpers (ISP-065 / #934)', () => {
  it('uses the same budgets as the server tiers', () => {
    expect(REPLICA_LAG_BUDGET_MS).toBe(10_000);
    expect(SEVERE_REPLICA_LAG_MS).toBe(30_000);
  });

  it('reads X-Replica-Lag-Ms from a Headers instance and from a plain object', () => {
    const headers = new Headers({ 'X-Replica-Lag-Ms': '12345' });
    expect(readReplicaLagHeader(headers)).toBe(12345);
    expect(readReplicaLagHeader({ 'x-replica-lag-ms': '2500' })).toBe(2500);
  });

  it('returns null for a missing, empty, negative or non-numeric header', () => {
    expect(readReplicaLagHeader(new Headers())).toBeNull();
    expect(readReplicaLagHeader({ 'x-replica-lag-ms': '' })).toBeNull();
    expect(readReplicaLagHeader({ 'x-replica-lag-ms': '-5' })).toBeNull();
    expect(readReplicaLagHeader({ 'x-replica-lag-ms': 'soon' })).toBeNull();
    expect(readReplicaLagHeader(null)).toBeNull();
  });

  it('shows no badge at or under the budget and the Stale badge above it', () => {
    expect(staleBadgeText(null)).toBeNull();
    expect(staleBadgeText(10_000)).toBeNull();
    expect(staleBadgeText(10_001)).toBe('⚠️ Stale ~10s');
    expect(staleBadgeText(15_400)).toBe('⚠️ Stale ~15s');
  });

  it('requires a dispatch override only in the severe tier', () => {
    expect(requiresDispatchOverride(null)).toBe(false);
    expect(requiresDispatchOverride(20_000)).toBe(false);
    expect(requiresDispatchOverride(30_000)).toBe(false);
    expect(requiresDispatchOverride(30_001)).toBe(true);
  });

  it('explains the delay in the override prompt', () => {
    expect(dispatchOverrideMessage(42_000)).toContain('about 42 seconds behind');
  });
});
