import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import type {
  FeatureFlagConfig,
  FeatureFlagRuleset,
  UserContext,
  FlagEvaluationResult,
} from '../types/index.js'
import { createAuditTape } from './ringBuffer'

// Deterministic hashing for percentage rollouts (0 - 99)
export function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash |= 0 // Convert to 32bit integer
  }
  return Math.abs(hash) % 100
}

export class FeatureFlagEvaluator {
  private config: FeatureFlagConfig | null = null
  private defaultContext: UserContext = { environment: 'production' }

  constructor(initialConfig?: FeatureFlagConfig) {
    if (initialConfig) {
      this.config = initialConfig
    }
  }

  public setConfig(config: FeatureFlagConfig): void {
    this.config = config
  }

  public getConfig(): FeatureFlagConfig | null {
    return this.config
  }

  public async fetchRemoteConfig(configUrl = '/config.json'): Promise<FeatureFlagConfig | null> {
    try {
      const response = await fetch(configUrl)
      if (response.ok) {
        const data = (await response.json()) as FeatureFlagConfig
        this.config = data
        return data
      }
    } catch (err) {
      console.warn('[FeatureFlagEvaluator] Remote config fetch failed, using defaults:', err)
    }
    return this.config
  }

  public evaluateFlag(flagKey: string, userContext?: UserContext): FlagEvaluationResult {
    const context = { ...this.defaultContext, ...userContext }
    const userIdentifier = context.id || context.deviceId || 'anonymous-device'
    const env = context.environment || 'production'

    // 1. Environment Variable Override (e.g. VITE_FLAG_EMERGENCY_BROADCASTER=true)
    const envVarKey = `VITE_FLAG_${flagKey.toUpperCase()}`
    const metaEnv = (import.meta as any).env
    if (metaEnv && metaEnv[envVarKey] !== undefined) {
      const envValue = metaEnv[envVarKey] === 'true' || metaEnv[envVarKey] === '1'
      return { flagKey, enabled: envValue, reason: 'env_override' }
    }

    if (!this.config || !this.config.flags || !this.config.flags[flagKey]) {
      return { flagKey, enabled: false, reason: 'default' }
    }

    const ruleset: FeatureFlagRuleset = this.config.flags[flagKey]

    // 2. Global Disabled Check
    if (!ruleset.enabled) {
      return { flagKey, enabled: false, reason: 'disabled' }
    }

    // 3. Environment Specific Overrides in Ruleset
    if (ruleset.environmentOverrides && ruleset.environmentOverrides[env] !== undefined) {
      return { flagKey, enabled: ruleset.environmentOverrides[env], reason: 'env_override' }
    }

    // 4. Target Matching (Roles / Environments / User IDs)
    if (ruleset.targets) {
      if (ruleset.targets.userIds && context.id && ruleset.targets.userIds.includes(context.id)) {
        return { flagKey, enabled: true, reason: 'target_match' }
      }
      if (ruleset.targets.roles && context.role && !ruleset.targets.roles.includes(context.role)) {
        return { flagKey, enabled: false, reason: 'disabled' }
      }
      if (ruleset.targets.environments && env && !ruleset.targets.environments.includes(env)) {
        return { flagKey, enabled: false, reason: 'disabled' }
      }
    }

    // 5. Percentage Canary Rollouts
    const rolloutPercentage = ruleset.rolloutPercentage ?? 100
    if (rolloutPercentage >= 100) {
      return { flagKey, enabled: true, reason: 'percentage_rollout' }
    }
    if (rolloutPercentage <= 0) {
      return { flagKey, enabled: false, reason: 'percentage_rollout' }
    }

    const userHash = hashString(`${userIdentifier}:${flagKey}`)
    const isBucketEnabled = userHash < rolloutPercentage

    return { flagKey, enabled: isBucketEnabled, reason: 'percentage_rollout' }
  }
}

// Global Evaluator Singleton Instance
export const defaultEvaluator = new FeatureFlagEvaluator()

interface FeatureFlagContextValue {
  evaluator: FeatureFlagEvaluator
  config: FeatureFlagConfig | null
  userContext: UserContext
  setUserContext: (ctx: UserContext) => void
  refreshConfig: () => Promise<void>
}

const FeatureFlagContext = createContext<FeatureFlagContextValue | undefined>(undefined)

export const FeatureFlagProvider: React.FC<{
  children: ReactNode
  initialConfig?: FeatureFlagConfig
  configUrl?: string
  defaultUserContext?: UserContext
}> = ({ children, initialConfig, configUrl = '/config.json', defaultUserContext }) => {
  const [evaluator] = useState(() => new FeatureFlagEvaluator(initialConfig))
  const [config, setConfig] = useState<FeatureFlagConfig | null>(initialConfig || null)
  const [userContext, setUserContext] = useState<UserContext>(
    defaultUserContext || { environment: 'production' }
  )

  const refreshConfig = async () => {
    const fetched = await evaluator.fetchRemoteConfig(configUrl)
    if (fetched) setConfig(fetched)
  }

  useEffect(() => {
    refreshConfig()
  }, [configUrl])

  return React.createElement(
    FeatureFlagContext.Provider,
    { value: { evaluator, config, userContext, setUserContext, refreshConfig } },
    children
  )
}

export function useFeatureFlags() {
  const context = useContext(FeatureFlagContext)
  if (!context) {
    throw new Error('useFeatureFlags must be used within a FeatureFlagProvider')
  }
  return context
}

export function useFeatureFlag(flagKey: string, userContextOverride?: UserContext): boolean {
  const context = useContext(FeatureFlagContext)
  if (!context) {
    return defaultEvaluator.evaluateFlag(flagKey, userContextOverride).enabled
  }

  const effectiveContext = userContextOverride || context.userContext
  return context.evaluator.evaluateFlag(flagKey, effectiveContext).enabled
}

// ── Kill-switch runtime (#797) ──────────────────────────────────────────────
// Versioned, TTL'd, offline-capable flag state shared by the main thread and
// every worker. Kill-switches are evaluated against a staleness budget: a
// critical kill whose last-known-good state is older than `maxStaleMs` fails
// closed (feature disabled) instead of trusting a stale "on".

export type FlagStaleness = 'fresh' | 'stale' | 'expired'

export interface KillSwitchPolicy {
  /** Age past which the cached state is "stale" (still honoured, labelled). */
  ttlMs: number
  /** Age past which the cached state is "expired" and `failClosed` applies. */
  maxStaleMs: number
  /** Expired → disabled (true) or expired → last-known-good (false). */
  failClosed: boolean
}

/**
 * Per-switch criticality. Soroban submit fails *open* when expired: blocking a
 * rescue because a device was offline is worse than a late kill, and the
 * server enforces the kill independently. Debug logs fail closed immediately.
 */
export const KILL_SWITCH_POLICIES: Record<string, KillSwitchPolicy> = {
  'telemetry.upload': { ttlMs: 60_000, maxStaleMs: 24 * 3_600_000, failClosed: true },
  'soroban.submit': { ttlMs: 60_000, maxStaleMs: 5 * 60_000, failClosed: false },
  'yjs.sync': { ttlMs: 60_000, maxStaleMs: 3_600_000, failClosed: false },
  'mapbox.highres': { ttlMs: 60_000, maxStaleMs: 3_600_000, failClosed: true },
  'debug.verboseLogs': { ttlMs: 0, maxStaleMs: 0, failClosed: true },
}

export interface FlagSnapshot {
  version: string
  fetchedAt: number
  /** Kill-switch key → enabled. Unknown keys are ignored by old clients. */
  kills: Record<string, boolean>
}

const FLAG_STORAGE_KEY = 'helphone.flags'
const FLAG_CHANNEL = 'helphone-flags'
const UNVERSIONED = '0'

let snapshot: FlagSnapshot = loadSnapshot()
const listeners = new Set<(s: FlagSnapshot) => void>()
let channel: BroadcastChannel | null = null
/** Flag-change audit tape: every version transition this device saw. */
export const flagAuditTape = createAuditTape(64)

function loadSnapshot(): FlagSnapshot {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(FLAG_STORAGE_KEY) : null
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed.version === 'string' && typeof parsed.fetchedAt === 'number') {
      return { version: parsed.version, fetchedAt: parsed.fetchedAt, kills: parsed.kills ?? {} }
    }
  } catch {}
  return { version: UNVERSIONED, fetchedAt: 0, kills: {} }
}

/** Compares numeric-ish versions ("12" > "9"); falls back to string order. */
export function compareFlagVersions(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return a < b ? -1 : a > b ? 1 : 0
}

export function currentFlagSnapshot(): FlagSnapshot {
  return snapshot
}

export function currentFlagVersion(): string {
  return snapshot.version
}

export function flagStaleness(key: string, now = Date.now(), s: FlagSnapshot = snapshot): FlagStaleness {
  const policy = KILL_SWITCH_POLICIES[key]
  const age = s.fetchedAt ? now - s.fetchedAt : Infinity
  if (!policy) return age === Infinity ? 'expired' : 'fresh'
  if (age <= policy.ttlMs) return 'fresh'
  if (age <= policy.maxStaleMs) return 'stale'
  return 'expired'
}

/**
 * Offline-safe kill-switch evaluation. Never fetches; answers from the
 * last-known-good snapshot with an explicit staleness label so the UI can
 * show a degraded-mode banner.
 */
export function evaluateKillSwitch(key: string, now = Date.now(), s: FlagSnapshot = snapshot) {
  const staleness = flagStaleness(key, now, s)
  const policy = KILL_SWITCH_POLICIES[key]
  // Unknown switches: experiments default open, never block on them.
  const known = key in s.kills
  let enabled = known ? s.kills[key] : true
  if (staleness === 'expired' && policy?.failClosed) enabled = false
  return { key, enabled, staleness, version: s.version, degraded: staleness !== 'fresh' }
}

/**
 * Applies a snapshot (poll result or WS `flags.patch`) iff it is newer, then
 * persists it and fans it out to other tabs and workers. Returns true when
 * the state changed.
 */
export function applyFlagSnapshot(next: FlagSnapshot, { broadcast = true } = {}): boolean {
  if (!next || typeof next.version !== 'string') return false
  const newer = compareFlagVersions(next.version, snapshot.version) > 0
  const sameButRefreshed = next.version === snapshot.version && next.fetchedAt > snapshot.fetchedAt
  if (!newer && !sameButRefreshed) return false
  if (newer) flagAuditTape.push({ at: Date.now(), kind: 'flags.version', from: snapshot.version, to: next.version })
  snapshot = { version: next.version, fetchedAt: next.fetchedAt || Date.now(), kills: { ...next.kills } }
  try {
    localStorage.setItem(FLAG_STORAGE_KEY, JSON.stringify(snapshot))
  } catch {}
  if (broadcast) channel?.postMessage({ type: 'flags.patch', snapshot })
  for (const fn of listeners) fn(snapshot)
  return true
}

export function onFlagSnapshot(fn: (s: FlagSnapshot) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Headers every envelope (dispatch, telemetry, replay) carries for server enforcement. */
export function flagHeaders(): Record<string, string> {
  return { 'x-helphone-flag-version': snapshot.version }
}

/**
 * Starts kill-switch propagation: BroadcastChannel (tabs + workers), WS push
 * when a socket is supplied, and a poll fallback that also runs in background
 * tabs with exponential backoff on failure. Returns a stop function.
 */
export function startFlagSync({
  url = '/api/flags',
  pollMs = 15_000,
  maxBackoffMs = 5 * 60_000,
  socket,
}: { url?: string; pollMs?: number; maxBackoffMs?: number; socket?: WebSocket } = {}): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let delay = pollMs

  if (typeof BroadcastChannel !== 'undefined' && !channel) {
    channel = new BroadcastChannel(FLAG_CHANNEL)
    channel.onmessage = (e) => {
      if (e.data?.type === 'flags.patch') applyFlagSnapshot(e.data.snapshot, { broadcast: false })
    }
  }

  const onSocket = (e: MessageEvent) => {
    try {
      const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
      if (msg?.type === 'flags.patch') applyFlagSnapshot({ ...msg.snapshot, fetchedAt: Date.now() })
    } catch {}
  }
  socket?.addEventListener('message', onSocket)

  const poll = async () => {
    if (stopped) return
    try {
      const res = await fetch(url, { headers: flagHeaders(), cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const body = await res.json()
      applyFlagSnapshot({ version: String(body.version), kills: body.kills ?? {}, fetchedAt: Date.now() })
      delay = pollMs
    } catch {
      delay = Math.min(delay * 2, maxBackoffMs)
    }
    if (!stopped) timer = setTimeout(poll, delay)
  }
  const onOnline = () => {
    clearTimeout(timer)
    delay = pollMs
    void poll()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onOnline)
  }
  void poll()

  return () => {
    stopped = true
    clearTimeout(timer)
    socket?.removeEventListener('message', onSocket)
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onOnline)
    }
  }
}

// ── Unified Remote + Field Flag Provenance (#943) ───────────────────────────
// Precedence order (highest to lowest):
//   1. env_override  (VITE_FLAG_*)
//   2. remote_config (public/config.json via defaultEvaluator)
//   3. field_local   (localStorage hp_feature_flags single-flag override)
//   4. default       (field flag defaultOn, or false)

export const FLAG_PRECEDENCE = Object.freeze([
  'env_override',
  'remote_config',
  'field_local',
  'default',
] as const)

export type FlagResolutionSource = (typeof FLAG_PRECEDENCE)[number]

export interface FieldLayerInput {
  override?: boolean | null
  defaultOn?: boolean
  version?: number | null
}

export interface UnifiedFlagResolution {
  flagName: string
  enabled: boolean
  source: FlagResolutionSource
  precedence: readonly FlagResolutionSource[]
  provenance: {
    remote: {
      present: boolean
      enabled: boolean
      reason: string
      version: string
    }
    field: {
      present: boolean
      enabled: boolean | null
      defaultOn: boolean | null
      version: number | null
    }
  }
}

/**
 * Single unified resolver combining remote config.json (defaultEvaluator)
 * and field localStorage flags with explicit, deterministic precedence.
 */
export function resolveUnifiedFlag(
  flagName: string,
  fieldLayer: FieldLayerInput = {},
  userContext?: UserContext,
  evaluator: FeatureFlagEvaluator = defaultEvaluator,
): UnifiedFlagResolution {
  const remoteEval = evaluator.evaluateFlag(flagName, userContext)
  const remoteVersion = evaluator.getConfig()?.version ?? currentFlagVersion()
  const remotePresent = remoteEval.reason !== 'default'

  const fieldOverride = typeof fieldLayer.override === 'boolean' ? fieldLayer.override : null
  const fieldDefault = typeof fieldLayer.defaultOn === 'boolean' ? fieldLayer.defaultOn : null
  const fieldVersion = typeof fieldLayer.version === 'number' ? fieldLayer.version : null

  let enabled = false
  let source: FlagResolutionSource = 'default'

  if (remoteEval.reason === 'env_override') {
    enabled = remoteEval.enabled
    source = 'env_override'
  } else if (remotePresent) {
    enabled = remoteEval.enabled
    source = 'remote_config'
  } else if (fieldOverride !== null) {
    enabled = fieldOverride
    source = 'field_local'
  } else if (fieldDefault !== null) {
    enabled = fieldDefault
    source = 'default'
  }

  return {
    flagName,
    enabled,
    source,
    precedence: FLAG_PRECEDENCE,
    provenance: {
      remote: {
        present: remotePresent,
        enabled: remoteEval.enabled,
        reason: remoteEval.reason,
        version: remoteVersion,
      },
      field: {
        present: fieldOverride !== null,
        enabled: fieldOverride,
        defaultOn: fieldDefault,
        version: fieldVersion,
      },
    },
  }
}

// ---------------------------------------------------------------------------
// predictiveEtaV2 convenience helpers (ADR-022 / this PR).
// Built on top of the unified resolver so both remote config and the
// field-local override storage keep working. No existing API is changed.
// ---------------------------------------------------------------------------

export const FEATURE_FLAGS = {
  predictiveEtaV2: 'predictiveEtaV2',
} as const

export type SimpleFeatureFlag = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS]

const SIMPLE_STORAGE_PREFIX = 'helphone:feature:'

function simpleStoredValue(flag: SimpleFeatureFlag): string | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined
    return localStorage.getItem(SIMPLE_STORAGE_PREFIX + flag) ?? undefined
  } catch {
    return undefined
  }
}

function parseSimple(value: string | undefined): boolean {
  if (value === undefined) return false
  return value === '1' || value.toLowerCase() === 'true'
}

/** True only when explicitly enabled by env, remote config or an override. */
export function isFeatureEnabled(flag: SimpleFeatureFlag): boolean {
  const override = simpleStoredValue(flag)
  if (override !== undefined) return parseSimple(override)
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> })?.env
    const envValue = env?.[`VITE_FEATURE_${flag.toUpperCase()}`]
    if (envValue !== undefined && envValue !== null) return parseSimple(String(envValue))
  } catch {
    /* no import.meta.env in a plain Node runtime */
  }
  const unified = resolveUnifiedFlag(flag)
  return unified.enabled && unified.source !== 'default'
}

export const isPredictiveEtaV2Enabled = (): boolean => isFeatureEnabled(FEATURE_FLAGS.predictiveEtaV2)

/** Test/E2E helper. Pass `null` to clear an override. */
export function setFeatureOverride(flag: SimpleFeatureFlag, value: boolean | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    const key = SIMPLE_STORAGE_PREFIX + flag
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value ? 'true' : 'false')
  } catch {
    /* storage disabled — flags stay at their env-derived defaults */
  }
}
