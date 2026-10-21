/**
 * Incident tape merge (#794): ring buffer + OTel spans + indexer events +
 * server logs → one skew-corrected, causally pinned, PII-scrubbed tape.
 *
 * Precedence (documented in docs/telemetry-architecture.md):
 *   1. Ledger events are authoritative: tCorrected = ledger closeTime,
 *      confidence = ledger granularity (5 s).
 *   2. Every other source is corrected by its estimated clock offset
 *      (clockSync.estimateOffset) and carries that estimate's confidence.
 *   3. Within one ring, monotonic order (`mono` / input order) beats wall clock.
 *   4. Ties inside the confidence window are broken by
 *      (ledgerSeq, source rank, original sequence): ledger sequence is the
 *      lamport clock.
 */
import { redactObject } from "./redact.js";

export const LEDGER_GRANULARITY_MS = 5_000;
const SOURCE_RANK = { ring: 0, log: 1, otel: 2, ledger: 3 };

function toMs(value) {
  if (value == null) return NaN;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value; // seconds → ms
  return Date.parse(value);
}

function pick(obj, keys) {
  for (const k of keys) if (obj?.[k] != null) return obj[k];
  return undefined;
}

/**
 * @param {object} inputs { ring?: [], otel?: [], ledger?: [], log?: [] }
 * @param {object} offsets per source { offsetMs, confidenceMs } (ring may be keyed by device)
 */
export function buildIncidentTape(inputs = {}, offsets = {}, { includeRaw = false } = {}) {
  const events = [];
  for (const source of ["ring", "log", "otel", "ledger"]) {
    const rows = Array.isArray(inputs[source]) ? inputs[source] : [];
    rows.forEach((row, seq) => {
      const raw = toMs(pick(row, ["closeTime", "ledger_close_time", "ts", "timestamp", "startTime", "created_at", "time", "wall"]));
      if (!Number.isFinite(raw)) return;
      let tCorrected = raw;
      let tConfidenceMs;
      if (source === "ledger") {
        tConfidenceMs = LEDGER_GRANULARITY_MS;
      } else {
        const off = offsets[`${source}:${row.device}`] || offsets[source] || { offsetMs: 0, confidenceMs: null };
        tCorrected = raw + (off.offsetMs || 0);
        // Unknown offset: say so instead of pretending to be exact.
        tConfidenceMs = off.confidenceMs ?? 60_000;
      }
      const ledgerSeq = Number(pick(row, ["ledgerSeq", "ledger_seq", "ledger"]));
      events.push({
        source,
        tRaw: raw,
        tCorrected: Math.round(tCorrected),
        tConfidenceMs,
        ledgerSeq: Number.isSafeInteger(ledgerSeq) ? ledgerSeq : null,
        seq: Number.isFinite(row.mono) ? row.mono : seq,
        device: row.device,
        dispatchId: pick(row, ["dispatchId", "dispatch_id", "requestId"]),
        traceId: pick(row, ["traceId", "trace_id"]),
        type: pick(row, ["type", "event", "name", "topic"]) ?? source,
        data: includeRaw ? row : redactObject(row),
      });
    });
  }

  events.sort((a, b) => {
    const window = Math.max(a.tConfidenceMs, b.tConfidenceMs);
    if (Math.abs(a.tCorrected - b.tCorrected) > window) return a.tCorrected - b.tCorrected;
    if (a.ledgerSeq != null && b.ledgerSeq != null && a.ledgerSeq !== b.ledgerSeq) return a.ledgerSeq - b.ledgerSeq;
    if (a.source === b.source && a.device === b.device) return a.seq - b.seq;
    if (a.tCorrected !== b.tCorrected) return a.tCorrected - b.tCorrected;
    return SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  });

  return events.map(({ seq: _seq, tRaw: _tRaw, ...e }, causalSeq) => ({ ...e, causalSeq }));
}
