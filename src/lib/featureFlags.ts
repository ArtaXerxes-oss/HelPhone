/**
 * Feature flags for HelPhone (ADR-022).
 *
 * Flags are OFF by default so flagged-off behaviour remains byte-identical.
 * Overrides can come from the environment (`VITE_FEATURE_PREDICTIVE_ETA_V2`)
 * or from localStorage (`helphone:feature:predictiveEtaV2`), which lets E2E
 * tests force the flag without a rebuild.
 */

export const FEATURE_FLAGS = {
  predictiveEtaV2: 'predictiveEtaV2',
} as const

export type FeatureFlag = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS]

const STORAGE_PREFIX = 'helphone:feature:'

function envValue(name: string): string | undefined {
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> })?.env
    const value = env?.[name]
    return value === undefined || value === null ? undefined : String(value)
  } catch {
    return undefined
  }
}

function storedValue(flag: FeatureFlag): string | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined
    return localStorage.getItem(STORAGE_PREFIX + flag) ?? undefined
  } catch {
    return undefined
  }
}

function parse(value: string | undefined): boolean {
  if (value === undefined) return false
  return value === '1' || value.toLowerCase() === 'true'
}

/** True only when the flag is explicitly enabled by env or localStorage. */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return parse(storedValue(flag)) || parse(envValue(`VITE_FEATURE_${flag.toUpperCase()}`))
}

export const isPredictiveEtaV2Enabled = (): boolean => isFeatureEnabled(FEATURE_FLAGS.predictiveEtaV2)

/** Test/E2E helper. Pass `null` to clear an override. */
export function setFeatureOverride(flag: FeatureFlag, value: boolean | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    const key = STORAGE_PREFIX + flag
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value ? 'true' : 'false')
  } catch {
    /* storage disabled — flags stay at their env-derived defaults */
  }
}
