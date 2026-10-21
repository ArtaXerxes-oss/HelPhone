/**
 * Synthetic route → field RUM slice mapping (#796).
 *
 * Every critical synthetic journey declares the RUM slice it stands in for,
 * using the same dimensions RUM samples carry (route template, step, cohort,
 * device class). The divergence view (GET /api/telemetry/divergence) and the
 * paging rules compare these two populations; a spec without an entry here has
 * no field equivalent and must not page.
 */
export interface RumEquivalent {
  spec: string
  route: string
  step: string
  cohort: string
  deviceClass: 'low' | 'mid' | 'high'
  /** perf-budget.json key whose budget both pipes are judged against. */
  budget: string
}

export const RUM_MAP: RumEquivalent[] = [
  { spec: 'emergency-flow.spec.ts', route: '/help', step: 'tapToConfirm', cohort: 'default', deviceClass: 'low', budget: 'endToEnd.tapToConfirm' },
  { spec: 'emergency-flow.spec.ts', route: '/help', step: 'mapReady', cohort: 'default', deviceClass: 'low', budget: 'links.mainThreadRender' },
  { spec: 'smoke.spec.ts', route: '/', step: 'firstPaint', cohort: 'default', deviceClass: 'low', budget: 'links.bundleParse' },
  { spec: 'wallet.spec.ts', route: '/ranking', step: 'rankingLoaded', cohort: 'default', deviceClass: 'mid', budget: 'links.wsRoundTrip' },
]

export function rumEquivalentFor(spec: string): RumEquivalent[] {
  return RUM_MAP.filter((m) => m.spec === spec)
}
