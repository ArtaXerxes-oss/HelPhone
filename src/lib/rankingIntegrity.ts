/**
 * Ranking integrity helpers (#772 / ISP-102).
 *
 * On-chain arrivals remain the primary signal (`getRanking`). This module adds:
 * - per-pair / per-day upvote caps
 * - self-dealing / velocity rejection
 * - proven vs probationary tier labels for the UI
 * - deterministic hybrid score reduce for offline CRDT merges
 */

export type ReputationTier = 'proven' | 'probationary' | 'quarantined'

export interface RankingEvent {
  id: string
  responderId: string
  requesterId: string
  kind: 'completion' | 'upvote'
  at: number
  proofValid?: boolean
  deviceId?: string
  ipHash?: string
}

export interface RankedResponder {
  responderId: string
  arrivals: number
  upvotes: number
  avgResponseMinutes: number
  score: number
  tier: ReputationTier
  provenCompletions: number
}

export interface IntegrityOptions {
  /** Max upvotes from the same requester→responder pair per UTC day. */
  upvoteCapPerPairPerDay?: number
  /** Completions faster than this (ms) between create and complete are farmed. */
  minCompletionGapMs?: number
  /** Soft weight for unproven community signals. */
  communityWeight?: number
  /** Hard weight for proof-backed completions. */
  provenWeight?: number
  /** Override whether proven-tier labels are permitted (defaults to pin alignment state). */
  allowProven?: boolean
}

export interface ReputationPinSpec {
  circuitCompilerVersion: string
  bbJs: string
  noirJs: string
  rankingGeneration: number
}

export interface ProverAlignmentResult {
  aligned: boolean
  reason?: string
  mismatches: string[]
  expected: ReputationPinSpec
  observed: Partial<ReputationPinSpec>
}

export const EXPECTED_REPUTATION_PINS: ReputationPinSpec = Object.freeze({
  circuitCompilerVersion: '>=0.36.0',
  bbJs: '0.87.9',
  noirJs: '1.0.0-beta.9',
  rankingGeneration: 1,
})

let activeAlignment: ProverAlignmentResult = {
  aligned: true,
  mismatches: [],
  expected: EXPECTED_REPUTATION_PINS,
  observed: { ...EXPECTED_REPUTATION_PINS },
}

function normalizeSemverPin(version: string | undefined): string {
  return typeof version === 'string' ? version.trim().replace(/^[\^~]/, '') : ''
}

/**
 * Verify that the reputation circuit compiler version, prover pins (@aztec/bb.js,
 * @noir-lang/noir_js), and ranking flag generation agree. Updates the module-level
 * alignment state so mismatches degrade proven-tier ranking to probationary.
 */
export function verifyReputationPinAlignment(
  observed: Partial<ReputationPinSpec>,
  expected: ReputationPinSpec = EXPECTED_REPUTATION_PINS,
): ProverAlignmentResult {
  const mismatches: string[] = []

  if (observed.circuitCompilerVersion !== expected.circuitCompilerVersion) {
    mismatches.push(
      `circuitCompilerVersion: expected ${expected.circuitCompilerVersion}, got ${observed.circuitCompilerVersion ?? 'missing'}`,
    )
  }
  if (normalizeSemverPin(observed.bbJs) !== normalizeSemverPin(expected.bbJs)) {
    mismatches.push(`@aztec/bb.js: expected ${expected.bbJs}, got ${observed.bbJs ?? 'missing'}`)
  }
  if (normalizeSemverPin(observed.noirJs) !== normalizeSemverPin(expected.noirJs)) {
    mismatches.push(`@noir-lang/noir_js: expected ${expected.noirJs}, got ${observed.noirJs ?? 'missing'}`)
  }
  if (observed.rankingGeneration !== expected.rankingGeneration) {
    mismatches.push(
      `rankingGeneration: expected ${expected.rankingGeneration}, got ${observed.rankingGeneration ?? 'missing'}`,
    )
  }

  const aligned = mismatches.length === 0
  activeAlignment = {
    aligned,
    reason: aligned ? undefined : `Reputation prover pin mismatch (${mismatches.join('; ')})`,
    mismatches,
    expected,
    observed: { ...observed },
  }
  return activeAlignment
}

export function getReputationPinAlignment(): ProverAlignmentResult {
  return activeAlignment
}

export function isProvenTierAllowed(): boolean {
  return activeAlignment.aligned
}

export function resetReputationPinAlignment(): void {
  activeAlignment = {
    aligned: true,
    mismatches: [],
    expected: EXPECTED_REPUTATION_PINS,
    observed: { ...EXPECTED_REPUTATION_PINS },
  }
}

/**
 * Boot-time alignment check. Reads optional overrides (or Vite env pins when
 * present) and degrades proven-tier ranking to probationary on mismatch.
 */
export function bootReputationPinCheck(
  observed?: Partial<ReputationPinSpec>,
): ProverAlignmentResult {
  const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env ?? {}
  const resolved: Partial<ReputationPinSpec> = {
    circuitCompilerVersion:
      observed?.circuitCompilerVersion ??
      metaEnv.VITE_REPUTATION_CIRCUIT_VERSION ??
      EXPECTED_REPUTATION_PINS.circuitCompilerVersion,
    bbJs: observed?.bbJs ?? metaEnv.VITE_PIN_BB_JS ?? EXPECTED_REPUTATION_PINS.bbJs,
    noirJs: observed?.noirJs ?? metaEnv.VITE_PIN_NOIR_JS ?? EXPECTED_REPUTATION_PINS.noirJs,
    rankingGeneration:
      observed?.rankingGeneration ??
      (metaEnv.VITE_RANKING_GENERATION != null
        ? Number(metaEnv.VITE_RANKING_GENERATION)
        : EXPECTED_REPUTATION_PINS.rankingGeneration),
  }
  const result = verifyReputationPinAlignment(resolved)
  if (!result.aligned) {
    console.warn(`[rankingIntegrity] ${result.reason}; degrading proven tier to probationary`)
  }
  return result
}

const DEFAULTS: Required<Omit<IntegrityOptions, 'allowProven'>> = {
  upvoteCapPerPairPerDay: 3,
  minCompletionGapMs: 5 * 60 * 1000,
  communityWeight: 0.25,
  provenWeight: 1,
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

/** Drop events that look like self-dealing or upvote spam. */
export function filterGamingEvents(
  events: RankingEvent[],
  options: IntegrityOptions = {},
): { accepted: RankingEvent[]; rejected: RankingEvent[] } {
  const opts = { ...DEFAULTS, ...options }
  const accepted: RankingEvent[] = []
  const rejected: RankingEvent[] = []
  const upvoteCounts = new Map<string, number>()
  const lastCompletion = new Map<string, number>()

  const sorted = [...events].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))

  for (const event of sorted) {
    if (event.responderId === event.requesterId) {
      rejected.push(event)
      continue
    }
    if (event.deviceId && event.ipHash) {
      // Same device + IP acting as both sides of many pairs → quarantine later.
    }
    if (event.kind === 'upvote') {
      const key = `${dayKey(event.at)}:${event.requesterId}->${event.responderId}`
      const count = upvoteCounts.get(key) ?? 0
      if (count >= opts.upvoteCapPerPairPerDay) {
        rejected.push(event)
        continue
      }
      upvoteCounts.set(key, count + 1)
    }
    if (event.kind === 'completion') {
      const prev = lastCompletion.get(event.responderId)
      if (prev != null && event.at - prev < opts.minCompletionGapMs && event.proofValid !== true) {
        rejected.push(event)
        continue
      }
      lastCompletion.set(event.responderId, event.at)
    }
    if (event.proofValid === false) {
      rejected.push(event)
      continue
    }
    accepted.push(event)
  }

  return { accepted, rejected }
}

/** Deterministic hybrid score. Same event log → same ranks. */
export function reduceRanking(
  events: RankingEvent[],
  options: IntegrityOptions = {},
): RankedResponder[] {
  const opts = { ...DEFAULTS, ...options }
  const { accepted } = filterGamingEvents(events, opts)
  const byResponder = new Map<
    string,
    {
      arrivals: number
      upvotes: number
      provenCompletions: number
      responseMinutes: number[]
      devices: Set<string>
      ips: Set<string>
    }
  >()

  for (const event of accepted) {
    const row = byResponder.get(event.responderId) ?? {
      arrivals: 0,
      upvotes: 0,
      provenCompletions: 0,
      responseMinutes: [],
      devices: new Set<string>(),
      ips: new Set<string>(),
    }
    if (event.kind === 'completion') {
      row.arrivals += 1
      if (event.proofValid) row.provenCompletions += 1
    }
    if (event.kind === 'upvote') row.upvotes += 1
    if (event.deviceId) row.devices.add(event.deviceId)
    if (event.ipHash) row.ips.add(event.ipHash)
    byResponder.set(event.responderId, row)
  }

  const ranked: RankedResponder[] = []
  for (const [responderId, row] of byResponder) {
    const avgResponseMinutes =
      row.responseMinutes.length === 0
        ? 0
        : row.responseMinutes.reduce((a, b) => a + b, 0) / row.responseMinutes.length
    const score =
      opts.provenWeight * row.provenCompletions +
      opts.communityWeight * Math.min(row.upvotes, 20) +
      0.5 * row.arrivals -
      0.05 * avgResponseMinutes

    const allowProven = options.allowProven ?? activeAlignment.aligned
    let tier: ReputationTier = 'probationary'
    if (row.provenCompletions >= 1 && allowProven) tier = 'proven'
    if (row.devices.size === 1 && row.ips.size === 1 && row.arrivals >= 8 && row.provenCompletions === 0) {
      tier = 'quarantined'
    }

    ranked.push({
      responderId,
      arrivals: row.arrivals,
      upvotes: row.upvotes,
      avgResponseMinutes,
      score: Number(score.toFixed(4)),
      tier,
      provenCompletions: row.provenCompletions,
    })
  }

  return ranked.sort(
    (a, b) =>
      b.score - a.score ||
      b.provenCompletions - a.provenCompletions ||
      a.responderId.localeCompare(b.responderId),
  )
}

/** Merge on-chain arrivals with local integrity tiers for the leaderboard UI. */
export function annotateLeaderboard(
  chainRows: Array<{ responder: string; total_arrivals: number }>,
  localEvents: RankingEvent[] = [],
  options: IntegrityOptions = {},
): Array<{ responder: string; total_arrivals: number; tier: ReputationTier; score: number }> {
  const reduced = reduceRanking(localEvents, options)
  const byId = new Map(reduced.map((r) => [r.responderId, r]))
  return chainRows
    .map((row) => {
      const local = byId.get(row.responder)
      const tier: ReputationTier =
        local?.tier ?? (row.total_arrivals > 0 ? 'probationary' : 'probationary')
      const score = local?.score ?? row.total_arrivals
      return { ...row, tier, score }
    })
    .filter((row) => row.tier !== 'quarantined')
    .sort((a, b) => b.score - a.score || b.total_arrivals - a.total_arrivals)
}
