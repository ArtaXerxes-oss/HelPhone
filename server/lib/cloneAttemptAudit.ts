import { createHmac } from 'node:crypto'
import { sendOperationalAlert, type OperationalAlert } from './alertWebhook.ts'

/**
 * Clone-attempt audit for #922. A responder DID that is claimed from more than
 * one place is recorded as a metadata-only event: a daily HMAC pseudonym,
 * the request id, and a count. The DID, coordinates and device details never
 * enter the audit record or the alert payload.
 */

export const CLONE_ATTEMPT_RULE = 'session_clone_attempt'

const RUNBOOK_URL = 'https://github.com/Hel-Phone/HelPhone/blob/main/docs/spikes/728-session-transfer-report.md'
const MIN_SECRET_LENGTH = 32

export interface CloneAttemptObservation {
  /** Responder DID. Only used to derive the pseudonym; never stored or sent. */
  did: string
  requestId: string
  /** Distinct claims (contract slots or devices) seen for the same DID. */
  distinctClaims: number
  observedAt: Date
}

/** Allowlisted audit record. Adding a field here is a privacy review, not a refactor. */
export interface CloneAttemptAudit {
  type: 'session_clone_attempt'
  pseudonym: string
  day: string
  requestId: string
  distinctClaims: number
  observedAt: string
}

/** Daily pseudonym: stable within a UTC day so an incident can be counted, unlinkable across days. */
export function dailyPseudonym(did: string, day: string, secret: string): string {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`clone audit secret must be at least ${MIN_SECRET_LENGTH} characters`)
  }
  return createHmac('sha256', secret)
    .update(`${day}|${did.trim().toUpperCase()}`)
    .digest('base64url')
    .slice(0, 16)
}

export function buildCloneAttemptAudit(observation: CloneAttemptObservation, { secret }: { secret: string }): CloneAttemptAudit {
  if (!Number.isInteger(observation.distinctClaims) || observation.distinctClaims < 2) {
    throw new Error('a clone attempt needs at least two distinct claims')
  }
  const day = observation.observedAt.toISOString().slice(0, 10)
  return {
    type: 'session_clone_attempt',
    pseudonym: dailyPseudonym(observation.did, day, secret),
    day,
    requestId: observation.requestId,
    distinctClaims: observation.distinctClaims,
    observedAt: observation.observedAt.toISOString(),
  }
}

/** Page on-call with a metadata-only alert. Returns false when no webhook is configured. */
export async function emitCloneAttemptAlert(
  audit: CloneAttemptAudit,
  options: { webhookUrl?: string; dashboardUrl?: string; fetch?: typeof fetch } = {},
): Promise<boolean> {
  const alert: OperationalAlert = {
    rule: CLONE_ATTEMPT_RULE,
    severity: 'page',
    summary: `Session clone attempt: ${audit.distinctClaims} claims for one pseudonymous responder (${audit.pseudonym}, ${audit.day})`,
    dashboardUrl: options.dashboardUrl ?? '',
    runbookUrl: RUNBOOK_URL,
  }
  return sendOperationalAlert(alert, { webhookUrl: options.webhookUrl, fetch: options.fetch })
}
