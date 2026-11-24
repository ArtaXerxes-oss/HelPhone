/**
 * ETA display with the predictiveEtaV2 flag (ADR-022).
 *
 * Flag OFF renders exactly the legacy single-number text. Flag ON renders the
 * estimator's bounded range and gives degraded/offline estimates a distinct
 * style plus a visible notice.
 */

import { isPredictiveEtaV2Enabled } from '../lib/featureFlags'
import { toEtaEstimate, type EtaEstimate } from '../lib/etaEstimate'

export interface EtaLabelProps {
  etaSeconds?: number | null
  degraded?: boolean
  runs?: number
}

/** Compute the range once so the label and notice stay consistent. */
export function useEtaRange(etaSeconds: number | null | undefined, options: { degraded?: boolean; runs?: number } = {}): EtaEstimate | null {
  if (!isPredictiveEtaV2Enabled() || etaSeconds == null) return null
  return toEtaEstimate(etaSeconds, options)
}

export function EtaLabel({ etaSeconds, degraded, runs }: EtaLabelProps) {
  const range = useEtaRange(etaSeconds, { degraded, runs })
  if (!range) {
    return <>{etaSeconds ? `${Math.round(etaSeconds / 60)} min` : ''}</>
  }
  return (
    <span
      data-testid="eta-range"
      className={range.degraded ? 'eta-degraded' : 'eta-range'}
      title={`Confidence ${range.confidence} (${Math.round(range.confidenceScore * 100)}%)`}
    >
      {range.label}
    </span>
  )
}

/** Visible notice shown only for degraded estimates under the flag. */
export function DegradedEtaNotice({ etaSeconds, degraded, runs }: EtaLabelProps) {
  const range = useEtaRange(etaSeconds, { degraded, runs })
  if (!range?.degraded) return null
  return (
    <div data-testid="eta-degraded-notice" className="eta-degraded-notice" role="status">
      Offline estimate — traffic data unavailable. Actual arrival may differ.
    </div>
  )
}
