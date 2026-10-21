import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  FeatureFlagEvaluator,
  hashString,
  defaultEvaluator,
} from '../src/lib/featureFlags.js'

describe('Dynamic Feature Canary Rollouts & State Evaluation', () => {
  let evaluator

  const mockConfig = {
    version: '1.0.0',
    flags: {
      emergency_broadcaster: { enabled: true, rolloutPercentage: 100 },
      disabled_feature: { enabled: false, rolloutPercentage: 100 },
      canary_50: { enabled: true, rolloutPercentage: 50 },
      target_admin_only: {
        enabled: true,
        rolloutPercentage: 100,
        targets: { roles: ['admin'] },
      },
      env_override_flag: {
        enabled: true,
        rolloutPercentage: 100,
        environmentOverrides: { development: true, production: false },
      },
    },
  }

  beforeEach(() => {
    evaluator = new FeatureFlagEvaluator(mockConfig)
  })

  it('should hash strings deterministically into 0-99 bucket percentage ranges', () => {
    const hash1 = hashString('user_123:canary_feature')
    const hash2 = hashString('user_123:canary_feature')
    const hash3 = hashString('user_456:canary_feature')

    expect(hash1).toBe(hash2)
    expect(hash1).toBeGreaterThanOrEqual(0)
    expect(hash1).toBeLessThan(100)
    expect(typeof hash3).toBe('number')
  })

  it('should evaluate 100% rollout flags as enabled and disabled flags as disabled', () => {
    const res1 = evaluator.evaluateFlag('emergency_broadcaster')
    expect(res1.enabled).toBe(true)
    expect(res1.reason).toBe('percentage_rollout')

    const res2 = evaluator.evaluateFlag('disabled_feature')
    expect(res2.enabled).toBe(false)
    expect(res2.reason).toBe('disabled')
  })

  it('should evaluate user targets correctly', () => {
    const adminRes = evaluator.evaluateFlag('target_admin_only', { role: 'admin' })
    expect(adminRes.enabled).toBe(true)

    const userRes = evaluator.evaluateFlag('target_admin_only', { role: 'user' })
    expect(userRes.enabled).toBe(false)
    expect(userRes.reason).toBe('disabled')
  })

  it('should evaluate environment overrides in config rulesets', () => {
    const devRes = evaluator.evaluateFlag('env_override_flag', { environment: 'development' })
    expect(devRes.enabled).toBe(true)

    const prodRes = evaluator.evaluateFlag('env_override_flag', { environment: 'production' })
    expect(prodRes.enabled).toBe(false)
  })

  it('should evaluate 50% canary rollout deterministically for different users', () => {
    let enabledCount = 0
    const totalUsers = 100

    for (let i = 0; i < totalUsers; i++) {
      const res = evaluator.evaluateFlag('canary_50', { id: `user_${i}` })
      if (res.enabled) enabledCount++
    }

    // Expect reasonable percentage distribution around 50%
    expect(enabledCount).toBeGreaterThan(25)
    expect(enabledCount).toBeLessThan(75)
  })

  it('should fallback gracefully when flag key is missing', () => {
    const res = evaluator.evaluateFlag('non_existent_flag')
    expect(res.enabled).toBe(false)
    expect(res.reason).toBe('default')
  })

  it('should fetch remote config from URL correctly', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockConfig,
    })

    const fetched = await evaluator.fetchRemoteConfig('/config.json')
    expect(fetchSpy).toHaveBeenCalledWith('/config.json')
    expect(fetched).toEqual(mockConfig)
    fetchSpy.mockRestore()
  })
})
