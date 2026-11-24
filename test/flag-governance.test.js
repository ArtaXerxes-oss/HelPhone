import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  auditFeatureFlags,
  promoteFlag,
} from '../scripts/audit-feature-flags.js';

describe('Flag-Governance Audit & Staged Rollout (#944)', () => {
  const configPath = path.join(process.cwd(), 'public/config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const fixedNow = new Date('2026-11-21T12:00:00Z');

  it('passes governance audit for current public/config.json and flags stale flags', () => {
    expect(auditFeatureFlags(config, { now: fixedNow }).ok).toBe(true);

    const stale = structuredClone(config);
    stale.flags.experimental_zk_v2.expiresAt = '2026-01-01T00:00:00Z';
    const res = auditFeatureFlags(stale, { now: fixedNow });
    expect(res.ok).toBe(false);
    expect(res.findings[0].reason).toContain('stale flag');
  });

  it('requires actor and reason and records audit events on flag flips', () => {
    expect(() =>
      promoteFlag({
        config,
        flagKey: 'experimental_zk_v2',
        targetStage: 'canary_10',
        actor: '',
        reason: 'canary start',
        pinAlignment: { aligned: true, mismatches: [] },
        now: fixedNow,
      }),
    ).toThrow(/actor/i);

    const promoted = promoteFlag({
      config,
      flagKey: 'experimental_zk_v2',
      targetStage: 'canary_10',
      actor: '@helphone-zk-owner',
      reason: 'Start 10% ZK v2 canary',
      pinAlignment: { aligned: true, mismatches: [] },
      now: fixedNow,
    });

    expect(promoted.flags.experimental_zk_v2.canaryStage).toBe('canary_10');
    expect(promoted.flags.experimental_zk_v2.rolloutPercentage).toBe(10);
    expect(promoted.flags.experimental_zk_v2.enabled).toBe(true);
    const lastEvent = promoted.auditLog.at(-1);
    expect(lastEvent).toMatchObject({
      flagKey: 'experimental_zk_v2',
      actor: '@helphone-zk-owner',
      reason: 'Start 10% ZK v2 canary',
      fromStage: 'off',
      toStage: 'canary_10',
      pinsAligned: true,
    });
  });

  it('blocks promotion of ZK/ranking flags when pins are misaligned or stage is skipped', () => {
    expect(() =>
      promoteFlag({
        config,
        flagKey: 'experimental_zk_v2',
        targetStage: 'canary_10',
        actor: '@helphone-zk-owner',
        reason: 'Attempt promotion with drifted pins',
        pinAlignment: { aligned: false, mismatches: ['@aztec/bb.js mismatch'] },
        now: fixedNow,
      }),
    ).toThrow(/misaligned/i);

    expect(() =>
      promoteFlag({
        config,
        flagKey: 'experimental_zk_v2',
        targetStage: 'ga_100',
        actor: '@helphone-zk-owner',
        reason: 'Attempt skipping canary stages',
        pinAlignment: { aligned: true, mismatches: [] },
        now: fixedNow,
      }),
    ).toThrow(/one stage at a time/i);
  });
});
