/**
 * History Routes
 *
 * REST API endpoints for querying indexed event history and merged
 * cross-border timelines across federated deployments (ISP-144).
 *
 * Paging (ISP-065 §2): every list endpoint pages with a keyset cursor over the
 * total order (server_seq, id). No endpoint uses LIMIT/OFFSET-style page
 * numbers, so a replica catching up between two requests cannot make rows be
 * skipped or repeated.
 */
import { Router, Request, Response } from 'express';
import type { ParsedEvent, CustodyMarker } from '../indexer/parser.js';
import { getHistoryConn, getReplicationLagMs, getAsOfLsn, REPLICA_LAG_BUDGET_MS } from '../db/connection.js';

const router = Router();

// In-memory event store fallback / cache for fast access and federated testing
const eventHistoryStore: (ParsedEvent & { id?: string | number; server_seq?: number; status?: string; created_at?: string })[] = [];
let globalHistorySeq = 0;

export function recordHistoryEvent(event: ParsedEvent & { id?: string | number; server_seq?: number; status?: string; created_at?: string }): void {
  if (!event.server_seq) {
    event.server_seq = ++globalHistorySeq;
  }
  if (!event.id) {
    event.id = event.requestId || `evt-${event.server_seq}`;
  }
  if (!event.status) {
    event.status = event.eventType === 'created' ? 'en-route' : event.eventType === 'resolved' ? 'delivered' : 'active';
  }
  if (!event.created_at) {
    event.created_at = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString();
  }
  eventHistoryStore.push(event);
  if (eventHistoryStore.length > 5000) {
    eventHistoryStore.shift();
  }
}

export function getHistoryEvents(): ParsedEvent[] {
  return [...eventHistoryStore];
}

export function clearHistoryEvents(): void {
  eventHistoryStore.length = 0;
  globalHistorySeq = 0;
}

export function encodeCursor(seq: number, id: string | number): string {
  return Buffer.from(`${seq}:${id}`).toString('base64url');
}

export function decodeCursor(cursorStr: string): { seq: number; id: string } | null {
  try {
    const raw = Buffer.from(cursorStr, 'base64url').toString('utf8');
    const idx = raw.indexOf(':');
    if (idx !== -1) {
      const seq = parseInt(raw.slice(0, idx), 10);
      const id = raw.slice(idx + 1);
      if (Number.isFinite(seq)) return { seq, id };
    }
  } catch {}
  return null;
}

type HistoryKeyed = { server_seq?: number; id?: string | number };

/** Code-unit comparison. Sort and cursor filter must use the same order, so this is used everywhere. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Total order for keyset paging: (server_seq, id). */
export function compareHistoryKey(a: HistoryKeyed, b: HistoryKeyed): number {
  const seqDiff = (a.server_seq || 0) - (b.server_seq || 0);
  if (seqDiff !== 0) return seqDiff;
  return compareText(String(a.id || ''), String(b.id || ''));
}

/** True when the row sorts strictly after the cursor position. */
export function isAfterCursor(row: HistoryKeyed, cursor: { seq: number; id: string }): boolean {
  const s = row.server_seq || 0;
  const id = String(row.id || '');
  return s > cursor.seq || (s === cursor.seq && compareText(id, cursor.id) > 0);
}

/**
 * Reads the `cursor` query parameter. An absent or empty value means the first
 * page. A present but undecodable value is rejected instead of being treated
 * as the first page, which would make a client loop forever.
 */
function parseCursorParam(raw: unknown): { ok: true; cursor: { seq: number; id: string } | null } | { ok: false } {
  if (raw === undefined || raw === '') return { ok: true, cursor: null };
  if (typeof raw !== 'string') return { ok: false };
  const cursor = decodeCursor(raw);
  return cursor ? { ok: true, cursor } : { ok: false };
}

/**
 * Every history response carries X-Next-Cursor. An empty value means there is
 * no next page, so clients can rely on the header always being present.
 */
function setNextCursor(res: Response, nextCursor: string | null): void {
  res.setHeader('X-Next-Cursor', nextCursor ?? '');
}

function staleResponse(res: Response, conn: { lagMs: number; asOfLsn: string; tier: string }) {
  res.setHeader('Retry-After', '5');
  return res.status(209).json({
    stale: true,
    tier: conn.tier,
    lagMs: conn.lagMs,
    asOfLsn: conn.asOfLsn,
    error: `Replica replication lag exceeds ${REPLICA_LAG_BUDGET_MS / 1000}s budget and primary reserve is unavailable`,
  });
}

// Attach lag and LSN headers to every history response
router.use(async (_req: Request, res: Response, next) => {
  try {
    const lagMs = await getReplicationLagMs();
    const asOfLsn = await getAsOfLsn();
    res.setHeader('X-Replica-Lag-Ms', String(Math.round(lagMs)));
    res.setHeader('X-As-Of-LSN', asOfLsn);
  } catch {}
  next();
});

/**
 * GET /api/history
 * Keyset cursor pagination over timeline / dispatch log.
 */
router.get('/', async (req: Request, res: Response) => {
  const parsed = parseCursorParam(req.query.cursor);
  if (!parsed.ok) return res.status(400).json({ error: 'Malformed cursor' });
  const cursor = parsed.cursor;
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit as string, 10) || 50));

  const conn = await getHistoryConn(REPLICA_LAG_BUDGET_MS);
  try {
    res.setHeader('X-Replica-Lag-Ms', String(Math.round(conn.lagMs)));
    res.setHeader('X-As-Of-LSN', conn.asOfLsn);

    if (conn.isStale) return staleResponse(res, conn);

    if (conn.client && typeof conn.client.query === 'function') {
      try {
        let querySql = 'SELECT * FROM dispatch_log ';
        const params: unknown[] = [];
        if (cursor) {
          querySql += 'WHERE (server_seq > $1 OR (server_seq = $1 AND id > $2)) ';
          params.push(cursor.seq, cursor.id);
        }
        querySql += `ORDER BY server_seq ASC, id ASC LIMIT $${params.length + 1}`;
        params.push(limit);

        const result = await conn.client.query(querySql, params);
        if (Array.isArray(result?.rows) && result.rows.length > 0) {
          const rows = result.rows as any[];
          const last = rows[rows.length - 1];
          const nextCursor = rows.length === limit ? encodeCursor(Number(last.server_seq || 0), last.id) : null;
          setNextCursor(res, nextCursor);
          return res.json(rows);
        }
      } catch {
        // Fall back to in-memory store
      }
    }

    let items = [...eventHistoryStore].sort(compareHistoryKey);
    if (cursor) items = items.filter((e) => isAfterCursor(e, cursor));

    const paged = items.slice(0, limit);
    const lastItem: any = paged[paged.length - 1];
    const nextCursor = lastItem && paged.length === limit ? encodeCursor(lastItem.server_seq || 0, lastItem.id || '') : null;
    setNextCursor(res, nextCursor);

    return res.json(paged);
  } finally {
    conn.release();
  }
});

/**
 * GET /api/history/events
 *
 * Query events with keyset cursor pagination, origin filtering, and custody
 * demarcation. Pages are ordered by (server_seq, id). The legacy `page` offset
 * parameter is no longer honoured; pass the `X-Next-Cursor` value as `cursor`.
 */
router.get('/events', async (req: Request, res: Response) => {
  const parsed = parseCursorParam(req.query.cursor);
  if (!parsed.ok) return res.status(400).json({ error: 'Malformed cursor' });
  const cursor = parsed.cursor;
  const limitNum = Math.min(500, Math.max(1, parseInt(req.query.limit as string, 10) || 50));

  const conn = await getHistoryConn(REPLICA_LAG_BUDGET_MS);
  try {
    res.setHeader('X-Replica-Lag-Ms', String(Math.round(conn.lagMs)));
    res.setHeader('X-As-Of-LSN', conn.asOfLsn);

    if (conn.isStale) return staleResponse(res, conn);

    const {
      type,
      origin_instance,
      custody_marker,
      include_foreign = 'true',
    } = req.query;

    let filtered = [...eventHistoryStore];

    if (include_foreign === 'false') {
      filtered = filtered.filter(
        (e) => !e.custodyMarker || e.custodyMarker === 'local_verified'
      );
    }

    if (type) {
      filtered = filtered.filter((e) => e.eventType === type);
    }

    if (origin_instance) {
      filtered = filtered.filter((e) => e.originInstance === origin_instance);
    }

    if (custody_marker) {
      filtered = filtered.filter((e) => e.custodyMarker === custody_marker);
    }

    const total = filtered.length;
    filtered.sort(compareHistoryKey);
    if (cursor) filtered = filtered.filter((e) => isAfterCursor(e, cursor));

    const paged = filtered.slice(0, limitNum);
    const hasMore = filtered.length > paged.length;
    const lastItem: any = paged[paged.length - 1];
    const nextCursor = hasMore && lastItem ? encodeCursor(lastItem.server_seq || 0, lastItem.id || '') : null;
    setNextCursor(res, nextCursor);

    res.json({
      events: paged,
      pagination: {
        limit: limitNum,
        total,
        hasMore,
        nextCursor,
      },
      lagMs: conn.lagMs,
      asOfLsn: conn.asOfLsn,
    });
  } catch (error) {
    console.error('[History] Error querying events:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
});

/**
 * GET /api/history/events/:requestId
 *
 * Get all events for a specific emergency request across local and peer sources.
 */
router.get('/events/:requestId', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.params;
    const events = eventHistoryStore.filter((e) => e.requestId === requestId);
    events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    res.json({
      requestId,
      events,
    });
  } catch (error) {
    console.error('[History] Error querying request events:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/history/timeline/:requestId
 *
 * Merged cross-border timeline with explicit provenance demarcation.
 * Flagged for tamper evidence and peer custody tracking.
 */
router.get('/timeline/:requestId', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.params;
    const events = eventHistoryStore.filter((e) => e.requestId === requestId);
    events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    const timeline = events.map((ev) => {
      const isPeer = ev.custodyMarker === 'peer_asserted';
      const hasTamper = ev.federationVerified === false;
      return {
        timestamp: ev.timestamp,
        eventType: ev.eventType,
        actor: ev.responderAddress || ev.callerAddress,
        originInstance: ev.originInstance || 'local',
        custodyMarker: ev.custodyMarker || 'local_verified',
        provenanceLabel: isPeer
          ? `Asserted by peer instance (${ev.originInstance})`
          : 'Verified by local DAO',
        tamperDetected: hasTamper,
        verificationError: ev.federationError,
        details: ev.raw?.data || {},
      };
    });

    res.json({
      requestId,
      totalEvents: timeline.length,
      hasTamperAlert: timeline.some((t) => t.tamperDetected),
      timeline,
    });
  } catch (error) {
    console.error('[History] Error building timeline:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/history/stats
 *
 * Get aggregate statistics about indexed events including federation breakdown.
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const byType: Record<string, number> = {};
    const byCustody: Record<string, number> = {
      local_verified: 0,
      peer_asserted: 0,
      relayed: 0,
    };
    let tamperedCount = 0;

    for (const ev of eventHistoryStore) {
      byType[ev.eventType] = (byType[ev.eventType] || 0) + 1;
      const marker = ev.custodyMarker || 'local_verified';
      byCustody[marker] = (byCustody[marker] || 0) + 1;
      if (ev.federationVerified === false) {
        tamperedCount++;
      }
    }

    res.json({
      totalEvents: eventHistoryStore.length,
      byType,
      byCustody,
      tamperedCount,
      latestLedger: 0,
    });
  } catch (error) {
    console.error('[History] Error fetching stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
