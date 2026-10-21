import { extractTrace, hopAttributes, parseTraceparent } from "../lib/traceContext.js";

export function normalizeContractEvent(event, { source = "soroban", observedAt = new Date().toISOString() } = {}) {
  const id = event.id || event.pagingToken || `${event.ledger || "unknown"}:${event.txHash || event.transactionHash || "unknown"}:${event.topic || "event"}`;
  return {
    id,
    source,
    observedAt,
    ledger: event.ledger || event.ledgerClosedAt || null,
    contractId: event.contractId || event.contract || null,
    type: event.type || event.topic || "contract_event",
    txHash: event.txHash || event.transactionHash || null,
    actor: event.actor || event.signer || null,
    payload: event.payload || event.value || event,
    // #791: join key back to the submitting trace. Comes from the event's
    // `trace` envelope, or from a `traceparent` recorded off-chain at submit
    // time (Soroban itself carries no trace context). Absent → null, never a
    // fresh poll-time trace.
    traceparent: traceparentOf(event),
    attributes: hopAttributes({
      dispatchId: event.dispatchId ?? event.requestId,
      txHash: event.txHash || event.transactionHash,
      ledgerSeq: event.ledger,
    }),
  };
}

function traceparentOf(event) {
  const fromEnvelope = extractTrace(event);
  if (fromEnvelope) return fromEnvelope.traceparent;
  return parseTraceparent(event.traceparent) ? event.traceparent.toLowerCase() : null;
}

export class InMemoryAuditSink {
  constructor({ maxEntries = 10_000 } = {}) {
    this.maxEntries = maxEntries;
    this.events = [];
    this.ids = new Set();
  }

  async append(event) {
    if (this.ids.has(event.id)) return false;
    this.ids.add(event.id);
    this.events.push(event);
    while (this.events.length > this.maxEntries) {
      const removed = this.events.shift();
      this.ids.delete(removed.id);
    }
    return true;
  }

  latest(limit = 100) {
    return this.events.slice(-limit).reverse();
  }
}

export class ContractEventStreamer {
  constructor({
    fetchEvents,
    sink = new InMemoryAuditSink(),
    cursor = null,
    intervalMs = 5_000,
    normalize = normalizeContractEvent,
    onError = () => {},
  } = {}) {
    if (typeof fetchEvents !== "function") throw new Error("fetchEvents function is required");
    this.fetchEvents = fetchEvents;
    this.sink = sink;
    this.cursor = cursor;
    this.intervalMs = intervalMs;
    this.normalize = normalize;
    this.onError = onError;
    this.timer = null;
    this.running = false;
  }

  async poll() {
    if (this.running) return { appended: 0, cursor: this.cursor };
    this.running = true;
    let appended = 0;
    try {
      const batch = await this.fetchEvents({ cursor: this.cursor });
      const events = Array.isArray(batch) ? batch : batch.events || [];
      for (const raw of events) {
        const normalized = this.normalize(raw);
        if (await this.sink.append(normalized)) appended++;
        this.cursor = raw.cursor || raw.pagingToken || normalized.id;
      }
      if (!Array.isArray(batch) && batch.cursor) this.cursor = batch.cursor;
      return { appended, cursor: this.cursor };
    } catch (err) {
      this.onError(err);
      throw err;
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      this.poll().catch(() => {});
    }, this.intervalMs);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function createAuditStreamer(options) {
  return new ContractEventStreamer(options);
}

export function createJoinReceipt({ snapshotId, highwater, pageCount, hash, clientVector = {} }) {
  return {
    receiptId: `rcpt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    snapshotId,
    highwater,
    pageCount,
    hash,
    clientVector,
    createdAt: new Date().toISOString(),
    verified: false,
  };
}

export function verifyJoinCompleteness(receipt, serverExpected) {
  if (!receipt || !serverExpected) return { complete: false, reason: 'missing_receipt_or_expected' };
  if (receipt.snapshotId !== serverExpected.snapshotId && serverExpected.snapshotId) {
    return { complete: false, reason: 'snapshot_mismatch' };
  }
  if (receipt.highwater < serverExpected.highwater) {
    return { complete: false, reason: 'highwater_behind', deviceHighwater: receipt.highwater, serverHighwater: serverExpected.highwater };
  }
  if (serverExpected.hash && receipt.hash !== serverExpected.hash) {
    return { complete: false, reason: 'hash_mismatch' };
  }
  receipt.verified = true;
  return { complete: true, receiptId: receipt.receiptId };
}
