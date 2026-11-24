/**
 * W3C trace-context helpers for async hops the OTel SDK cannot follow on its
 * own: Redis pub/sub, ledger polling and the indexer (#791).
 *
 * Contract: every message that crosses an async boundary carries a `trace`
 * field `{ v, traceparent, tracestate? }`. Receivers keep the traceId and
 * record the publisher span as a *link* (fan-out is many-to-many, so it is
 * never forced as the parent).
 */
import { randomBytes } from "node:crypto";

export const TRACE_ENVELOPE_VERSION = 1;
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().toLowerCase().match(TRACEPARENT_RE);
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null;
  return { traceId: match[1], spanId: match[2], flags: match[3] };
}

export function formatTraceparent({ traceId, spanId, flags = "01" }) {
  return `00-${traceId}-${spanId}-${flags}`;
}

export function newSpanId() {
  return randomBytes(8).toString("hex");
}

export function newTraceparent() {
  return formatTraceparent({ traceId: randomBytes(16).toString("hex"), spanId: newSpanId() });
}

/** Same trace, new span id: the hop that forwards a message. */
export function childTraceparent(parent) {
  const ctx = parseTraceparent(parent);
  return ctx ? formatTraceparent({ ...ctx, spanId: newSpanId() }) : newTraceparent();
}

/** Attach context to an outgoing message without mutating the caller's object. */
export function injectTrace(message, traceparent, tracestate) {
  const forwarded = childTraceparent(traceparent);
  const trace = { v: TRACE_ENVELOPE_VERSION, traceparent: forwarded };
  if (typeof tracestate === "string" && tracestate.length <= 512) trace.tracestate = tracestate;
  return { ...message, trace };
}

/**
 * Read context from an incoming message. Old publishers (no `trace` field)
 * are accepted and yield null, so mixed versions interoperate for a release.
 */
export function extractTrace(message) {
  const trace = message && typeof message === "object" ? message.trace : undefined;
  if (!trace || typeof trace !== "object") return null;
  const ctx = parseTraceparent(trace.traceparent);
  if (!ctx) return null;
  return {
    ...ctx,
    traceparent: formatTraceparent(ctx),
    tracestate: typeof trace.tracestate === "string" ? trace.tracestate : undefined,
    // Fan-out links recorded by upstream receivers are part of the envelope.
    links: Array.isArray(trace.links) ? trace.links : undefined,
  };
}

/** A fan-out receiver links to the publisher span; it never reparents it. */
export function linkFromContext(ctx) {
  return ctx ? { traceId: ctx.traceId, spanId: ctx.spanId } : null;
}

/**
 * Context for an indexer/subscriber hop: same traceId, a fresh span id for the
 * receiver, and a link back to the publishing span. Messages without a valid
 * trace produce null — polling must never start a fresh trace.
 */
export function hopContext(traceparent, priorLinks = []) {
  const parent = parseTraceparent(traceparent);
  if (!parent) return null;
  const child = parseTraceparent(childTraceparent(traceparent));
  const ownLink = linkFromContext(parent);
  const links = [...(Array.isArray(priorLinks) ? priorLinks : []), ownLink]
    .filter(Boolean)
    .filter((link, i, all) => all.findIndex((l) => l.traceId === link.traceId && l.spanId === link.spanId) === i)
    .slice(-16);
  return {
    traceId: parent.traceId,
    spanId: child.spanId,
    parentSpanId: parent.spanId,
    traceparent: formatTraceparent(child),
    links,
  };
}

/** Span attributes recorded at every hop so traces join to ledger rows. */
export function hopAttributes({ dispatchId, txHash, ledgerSeq } = {}) {
  const attrs = {};
  if (dispatchId != null) attrs["helphone.dispatch_id"] = String(dispatchId);
  if (txHash) attrs["stellar.tx_hash"] = String(txHash);
  if (Number.isSafeInteger(Number(ledgerSeq))) attrs["stellar.ledger_seq"] = Number(ledgerSeq);
  return attrs;
}
