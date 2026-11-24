/**
 * Gap-driven backfill (ISP-065 §3, issue #935).
 *
 * `parser.ts` detects non-contiguous per-client clocks. This module turns a
 * detected gap into a durable backfill request:
 *
 *   1. `ingestDispatchOps` records each gap in `indexer_gap_log` (once, even
 *      if the same batch is re-ingested after a crash) and still projects the
 *      whole batch. A gap never causes a batch to be dropped.
 *   2. `runBackfillPass` reads unresolved gap rows, asks an injected fetcher
 *      for the missing clocks, and projects them. A gap row is marked resolved
 *      only when every clock in its range is present. Partial answers stay
 *      unresolved and are retried on the next pass.
 *
 * The fetcher is injected because the source of missing ops (a peer, the
 * sync relay, or a replay of the ledger) is a deployment decision.
 */
import {
  detectClockGap,
  persistGapToDb,
  resolveGap,
  rewindClock,
  type ClockGap,
} from './parser.js';
import {
  projectDispatchBatch,
  type DispatchLogOp,
  type QueryRunner,
} from './exporter.js';

export interface BackfillRequest {
  docId: string;
  clientId: string;
  /** Inclusive. */
  fromClock: number;
  /** Inclusive. */
  toClock: number;
}

export type BackfillFetcher = (req: BackfillRequest) => Promise<DispatchLogOp[]>;

/** Ranges wider than this are left unresolved for a human rather than fetched in one go. */
export const MAX_BACKFILL_RANGE = 5_000;

export interface IngestResult {
  projectedCount: number;
  duplicateCount: number;
  gaps: ClockGap[];
}

/** Persists a gap unless an identical unresolved row already exists. Returns true when inserted. */
export async function recordClockGap(db: QueryRunner, gap: ClockGap): Promise<boolean> {
  const existing = await db.query(
    `SELECT 1 FROM indexer_gap_log
      WHERE doc_id = $1 AND client_id = $2
        AND expected_clock = $3 AND received_clock = $4
        AND resolved = FALSE
      LIMIT 1`,
    [gap.doc_id, gap.client_id, gap.expected_clock, gap.received_clock]
  );
  if (existing.rows.length > 0) return false;
  await persistGapToDb(db, gap);
  return true;
}

/**
 * Detects gaps in the batch, records them, and projects the full batch.
 * Ops are checked in clock order per doc/client, which is what the detector expects.
 */
export async function ingestDispatchOps(
  db: QueryRunner,
  ops: DispatchLogOp[],
  checkpoint: { lsn: string; seq: number } | null
): Promise<IngestResult> {
  const ordered = [...ops].sort((a, b) => {
    if (a.doc_id !== b.doc_id) return a.doc_id < b.doc_id ? -1 : 1;
    if (a.client_id !== b.client_id) return a.client_id < b.client_id ? -1 : 1;
    return a.clock - b.clock;
  });

  const gaps: ClockGap[] = [];
  for (const op of ordered) {
    const { hasGap, gap } = detectClockGap(op.doc_id, op.client_id, op.clock);
    if (hasGap && gap) {
      try {
        await recordClockGap(db, gap);
      } catch (err) {
        // The detector already moved past this gap. Rewind so a retry detects it again.
        rewindClock(gap.doc_id, gap.client_id, gap.expected_clock - 1);
        throw err;
      }
      gaps.push(gap);
    }
  }

  const { projectedCount, duplicateCount } = await projectDispatchBatch(db, ops, checkpoint);
  return { projectedCount, duplicateCount, gaps };
}

export interface BackfillPassResult {
  checked: number;
  resolved: number;
  /** Fetch returned an incomplete range. Retried on a later pass. */
  pending: number;
  /** Range too wide, or the fetch or projection threw. Left unresolved. */
  failed: number;
}

/**
 * One backfill pass over the oldest unresolved gaps. Projection is idempotent
 * (ON CONFLICT DO NOTHING), so a crash between projecting and marking a gap
 * resolved only causes a harmless re-fetch on the next pass.
 */
export async function runBackfillPass(
  db: QueryRunner,
  fetchRange: BackfillFetcher,
  { limit = 20, maxRange = MAX_BACKFILL_RANGE }: { limit?: number; maxRange?: number } = {}
): Promise<BackfillPassResult> {
  const pendingRes = await db.query(
    `SELECT id, doc_id, client_id, expected_clock, received_clock
       FROM indexer_gap_log
      WHERE resolved = FALSE
      ORDER BY detected_at ASC, id ASC
      LIMIT $1`,
    [limit]
  );

  const result: BackfillPassResult = { checked: 0, resolved: 0, pending: 0, failed: 0 };

  for (const row of pendingRes.rows as any[]) {
    result.checked++;
    const docId = String(row.doc_id);
    const clientId = String(row.client_id);
    const fromClock = Number(row.expected_clock);
    const toClock = Number(row.received_clock) - 1;

    if (toClock < fromClock) {
      // Nothing is missing (should not be stored, but resolving it is harmless).
      await db.query('UPDATE indexer_gap_log SET resolved = TRUE, resolved_at = NOW() WHERE id = $1', [row.id]);
      result.resolved++;
      continue;
    }
    if (toClock - fromClock + 1 > maxRange) {
      result.failed++;
      continue;
    }

    try {
      const fetched = await fetchRange({ docId, clientId, fromClock, toClock });
      const inRange = fetched.filter(
        (op) => op.doc_id === docId && op.client_id === clientId && op.clock >= fromClock && op.clock <= toClock
      );
      const present = new Set(inRange.map((op) => op.clock));
      let complete = true;
      for (let clock = fromClock; clock <= toClock; clock++) {
        if (!present.has(clock)) {
          complete = false;
          break;
        }
      }
      if (!complete) {
        result.pending++;
        continue;
      }

      // Projection without a checkpoint: a backfill replays older clocks and must not rewind the live exporter.
      await projectDispatchBatch(db, inRange, null);
      await db.query('UPDATE indexer_gap_log SET resolved = TRUE, resolved_at = NOW() WHERE id = $1', [row.id]);
      resolveGap(docId, clientId, fromClock);
      result.resolved++;
    } catch {
      result.failed++;
    }
  }

  return result;
}

/**
 * Runs `runBackfillPass` on an interval. Returns a stop function. The timer is
 * unref'd so it never keeps the process alive on its own.
 */
export function startBackfillScheduler(
  db: QueryRunner,
  fetchRange: BackfillFetcher,
  { intervalMs = 30_000, limit = 20, onError = (err: unknown) => console.error('[backfill] pass failed', err) } = {}
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runBackfillPass(db, fetchRange, { limit })
      .catch(onError)
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
