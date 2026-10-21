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

/** Parsed event types from the HelPhone contract */
export type EventType = 'created' | 'accepted' | 'arrived' | 'resolved' | 'unknown' | 'federated_dispatch' | 'federated_ack';

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

