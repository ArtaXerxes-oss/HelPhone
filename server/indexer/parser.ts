/**
 * Event Parser
 *
 * Decodes XDR event topics and data into structured records
 * for storage in the PostgreSQL event_index table.
 *
 * #792: `raw.data` is redacted before it leaves the parser — free-text
 * notes/memo are dropped, phone/contact pseudonymized (HMAC), coordinates
 * coarsened to ~110 m. Typed lat/lng are kept for geo queries.
 */
// @ts-ignore — plain JS helper shared with the Express server
import { redactObject } from '../lib/redact.js';
import {
  classifyFinality,
  isOrphaned,
  DEFAULT_FINALITY_DEPTH,
  type FinalityTier,
  type FinalityOptions,
  type LedgerSighting,
} from '../lib/finality.js';

/** Parsed event types from the HelPhone contract */
export type EventType = 'created' | 'accepted' | 'arrived' | 'resolved' | 'unknown' | 'federated_dispatch' | 'federated_ack' | 'checkpoint_committed';

export type CustodyMarker = 'local_verified' | 'peer_asserted' | 'relayed';

/** Structured event record after parsing */
export interface ParsedEvent {
  eventType: EventType;
  requestId?: string;
  responderAddress?: string;
  callerAddress?: string;
  timestamp?: number;
  latitude?: number;
  longitude?: number;
  originInstance?: string;
  custodyMarker?: CustodyMarker;
  federationEnvelopeId?: string;
  federationVerified?: boolean;
  federationError?: string;
  raw: {
    topics: string[];
    data: any;
  };
}

/**
 * Map contract event topic to a typed event name.
 */
export function classifyEvent(topics: string[]): EventType {
  const topic = topics[0]?.toLowerCase() || '';

  if (topic.includes('request_created') || topic.includes('emergency_created')) {
    return 'created';
  }
  if (topic.includes('request_accepted') || topic.includes('responder_joined')) {
    return 'accepted';
  }
  if (topic.includes('responder_arrived') || topic.includes('on_scene')) {
    return 'arrived';
  }
  if (topic.includes('request_resolved') || topic.includes('emergency_resolved')) {
    return 'resolved';
  }

  return 'unknown';
}

/**
 * Parse event data into a structured record.
 */
export function parseEvent(topics: string[], data: any): ParsedEvent {
  const eventType = classifyEvent(topics);

  const parsed: ParsedEvent = {
    eventType,
    raw: { topics, data: redactObject(data) },
  };

  // Extract common fields from topics (indices depend on contract design)
  if (topics.length > 1) parsed.requestId = topics[1];
  if (topics.length > 2) parsed.responderAddress = topics[2];
  if (topics.length > 3) parsed.callerAddress = topics[3];

  // Extract fields from data object
  if (data && typeof data === 'object') {
    if (data.timestamp) parsed.timestamp = Number(data.timestamp);
    if (data.latitude) parsed.latitude = Number(data.latitude);
    if (data.longitude) parsed.longitude = Number(data.longitude);
  }

  return parsed;
}

/**
 * Batch parse multiple events.
 */
export function parseEvents(
  events: Array<{ topics: string[]; data: any }>
): ParsedEvent[] {
  return events.map(e => parseEvent(e.topics, e.data));
}

/**
 * Ingest foreign-origin event with explicit custody markers.
 */
export function parseFederatedEvent(
  envelope: {
    envelopeId: string;
    senderInstance: string;
    recipientInstance: string;
    payloadType: string;
    payload: any;
    timestamp: number;
  },
  verificationResult: { verified: boolean; error?: string }
): ParsedEvent {
  const isDispatch = envelope.payloadType === 'dispatch';
  const isAck = envelope.payloadType === 'ack';
  const eventType: EventType = isDispatch
    ? 'federated_dispatch'
    : isAck
    ? 'federated_ack'
    : 'unknown';

  return {
    eventType,
    requestId: envelope.payload?.requestId || envelope.payload?.incidentId || envelope.payload?.id,
    responderAddress: envelope.payload?.responder || envelope.payload?.responderAddress,
    timestamp: envelope.timestamp,
    originInstance: envelope.senderInstance,
    custodyMarker: 'peer_asserted',
    federationEnvelopeId: envelope.envelopeId,
    federationVerified: verificationResult.verified,
    federationError: verificationResult.error,
    raw: {
      topics: [eventType, envelope.senderInstance, envelope.recipientInstance],
      data: envelope.payload,
    },
  };
}

export interface ClockGap {
  id?: string;
  doc_id: string;
  client_id: string;
  expected_clock: number;
  received_clock: number;
  gap_size: number;
  detected_at: number;
  resolved: boolean;
}

const docClockMap = new Map<string, number>();
const gapLog: ClockGap[] = [];

export function resetGapDetector(): void {
  docClockMap.clear();
  gapLog.length = 0;
}

export interface ClockHighWaterMark {
  doc_id: string;
  client_id: string;
  max_clock: number;
}

/**
 * Puts a doc/client clock back to `clock`. `detectClockGap` advances the clock
 * as soon as it sees a gap, so callers use this when they fail to persist the
 * gap. That way a retry detects the gap again instead of losing it.
 */
export function rewindClock(docId: string, clientId: string, clock: number): void {
  docClockMap.set(`${docId}:${clientId}`, Math.max(0, clock));
}

/**
 * Seeds the gap detector from already-projected clocks (e.g. `MAX(clock)` per
 * doc/client in `dispatch_log`). Without this, the first op a client sends
 * after a restart would look like a gap back to clock 1. Never lowers a clock.
 */
export function seedClockHighWaterMarks(marks: ClockHighWaterMark[]): number {
  let seeded = 0;
  for (const mark of marks) {
    const clock = Number(mark.max_clock);
    if (!Number.isFinite(clock) || clock <= 0) continue;
    const key = `${mark.doc_id}:${mark.client_id}`;
    if (clock > (docClockMap.get(key) ?? 0)) {
      docClockMap.set(key, clock);
      seeded++;
    }
  }
  return seeded;
}

/**
 * Detect gaps in per-doc / per-client clock sequences to prevent silent dropped operations.
 */
export function detectClockGap(
  docId: string,
  clientId: string,
  clock: number
): { hasGap: boolean; expectedClock: number; gap?: ClockGap } {
  const key = `${docId}:${clientId}`;
  const lastClock = docClockMap.get(key) ?? 0;

  if (clock > lastClock + 1) {
    const gap: ClockGap = {
      doc_id: docId,
      client_id: clientId,
      expected_clock: lastClock + 1,
      received_clock: clock,
      gap_size: clock - (lastClock + 1),
      detected_at: Date.now(),
      resolved: false,
    };
    gapLog.push(gap);
    docClockMap.set(key, clock);
    return { hasGap: true, expectedClock: lastClock + 1, gap };
  }

  if (clock > lastClock) {
    docClockMap.set(key, clock);
  }

  return { hasGap: false, expectedClock: lastClock + 1 };
}

export function getIndexerGaps(): ClockGap[] {
  return [...gapLog];
}

export function getUnresolvedGaps(): ClockGap[] {
  return gapLog.filter((g) => !g.resolved);
}

export function resolveGap(docId: string, clientId: string, clock: number): boolean {
  let resolvedAny = false;
  for (const gap of gapLog) {
    if (gap.doc_id === docId && gap.client_id === clientId && !gap.resolved) {
      if (clock >= gap.expected_clock && clock < gap.received_clock) {
        gap.resolved = true;
        resolvedAny = true;
      }
    }
  }
  return resolvedAny;
}

export async function persistGapToDb(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  gap: ClockGap
): Promise<void> {
  await client.query(
    `INSERT INTO indexer_gap_log (doc_id, client_id, expected_clock, received_clock, gap_size, resolved)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [gap.doc_id, gap.client_id, gap.expected_clock, gap.received_clock, gap.gap_size, gap.resolved]
  );
}


// ── CheckpointCommitted branch (issue #916, spike #727) ──────────────────────
//
// A CheckpointCommitted event is emitted by the contract when a ledger is
// closed and recorded on-chain.  First sight is ALWAYS pending (depth 0);
// it can never arrive as finalized because the tip ledger has depth 0 by
// definition.  The indexer re-classifies stored sightings as deeper ledgers
// arrive.

export interface ParsedCheckpoint {
  eventType: 'checkpoint_committed';
  /** Ledger sequence number of the checkpoint. */
  ledger: number;
  /** Canonical ledger hash from the contract event. */
  ledgerHash: string;
  /**
   * Depth behind the current tip at parse time.
   * First sight = 0 (pending).  Callers must re-classify when the tip advances.
   */
  depth: number;
  /** Finality tier derived from depth and k at parse time. */
  finalityTier: FinalityTier;
  raw: { topics: string[]; data: unknown };
}

/**
 * Parse a raw `CheckpointCommitted` contract event into a `ParsedCheckpoint`.
 *
 * Topic layout (0-indexed):
 *   [0] event name ("CheckpointCommitted" or variant)
 *   [1] ledger sequence (string-encoded u32)
 *   [2] ledger hash (hex string)
 *
 * `currentTip` is the tip ledger sequence at parse time — used to derive
 * the initial depth.  Pass the value from `getLatestLedger` or the event
 * stream cursor; default to `ledger` itself when unavailable so depth = 0.
 */
export function parseCheckpointCommitted(
  topics: string[],
  data: unknown,
  currentTip?: number,
  options: FinalityOptions = {},
): ParsedCheckpoint {
  const ledger = Number(topics[1] ?? '0');
  const ledgerHash = String(topics[2] ?? '');

  if (!Number.isInteger(ledger) || ledger <= 0) {
    throw new RangeError(`CheckpointCommitted: invalid ledger sequence "${topics[1]}"`);
  }
  if (!ledgerHash) {
    throw new TypeError('CheckpointCommitted: missing ledger hash in topics[2]');
  }

  // First sight of a checkpoint is always at depth 0 (pending).  The tip at
  // parse time should equal or exceed the checkpoint ledger; guard against
  // callers passing a stale tip that would yield a negative depth.
  const tip = currentTip ?? ledger;
  const depth = Math.max(0, tip - ledger);
  const finalityTier = classifyFinality(depth, options);

  return {
    eventType: 'checkpoint_committed',
    ledger,
    ledgerHash,
    depth,
    finalityTier,
    raw: { topics, data: redactObject(data) },
  };
}

/**
 * Re-classify a stored checkpoint sighting when the tip advances.
 * Returns a new object; does not mutate the original.
 *
 * If `newSighting.ledgerHash` differs from the stored hash the checkpoint
 * is marked orphaned regardless of depth.
 */
export function reclassifyCheckpoint(
  stored: ParsedCheckpoint,
  newTip: number,
  newSighting?: LedgerSighting,
  options: FinalityOptions = {},
): ParsedCheckpoint {
  if (newSighting && isOrphaned({ ledger: stored.ledger, ledgerHash: stored.ledgerHash }, newSighting)) {
    return { ...stored, finalityTier: 'orphaned', depth: stored.depth };
  }
  const depth = Math.max(0, newTip - stored.ledger);
  return { ...stored, depth, finalityTier: classifyFinality(depth, options) };
}
