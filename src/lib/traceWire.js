/**
 * Dependency-free W3C trace-context wire helpers (#791).
 *
 * This module is intentionally plain JavaScript with no OTel or Node imports
 * so the same code can run in the browser bundle, in the Node test runner and
 * in server-side hops. The OTel integration in `telemetry.ts` supplies the
 * active span context; everything here is pure formatting/injection logic.
 */

export const TRACE_WIRE_VERSION = 1

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

/** Fields injected into main-thread → worker messages. */
export const WORKER_TRACE_VERSION_FIELD = '__traceVersion'
export const WORKER_TRACEPARENT_FIELD = '__traceparent'

function randomHex(bytes) {
  const webcrypto = globalThis.crypto
  if (!webcrypto || typeof webcrypto.getRandomValues !== 'function') {
    throw new Error('Web Crypto (crypto.getRandomValues) is required for trace propagation')
  }
  return Array.from(webcrypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

export function parseTraceparent(value) {
  if (typeof value !== 'string') return null
  const match = value.trim().toLowerCase().match(TRACEPARENT_RE)
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null
  return { traceId: match[1], spanId: match[2], flags: match[3] }
}

export function formatTraceparent({ traceId, spanId, flags = '01' }) {
  return `00-${traceId}-${spanId}-${flags}`
}

export function newSpanId() {
  return randomHex(8)
}

export function newTraceparent() {
  return formatTraceparent({ traceId: randomHex(16), spanId: newSpanId() })
}

/** Same trace, fresh span id: the forwarding hop. */
export function childTraceparent(parent) {
  const ctx = parseTraceparent(parent)
  return ctx ? formatTraceparent({ ...ctx, spanId: newSpanId() }) : newTraceparent()
}

export function traceIdsFromTraceparent(traceparent) {
  const ctx = parseTraceparent(traceparent)
  return ctx ? { traceId: ctx.traceId, spanId: ctx.spanId } : null
}

/**
 * PWA → HTTP carrier. Returns a copy of `headers` with a child traceparent.
 * An inbound traceparent (from an upstream hop) is continued; absent one the
 * tap is the trace origin and a new trace is started, as documented.
 */
export function traceHeaders(headers = {}, parentTraceparent) {
  const base = headers && typeof headers === 'object' ? headers : {}
  const outgoing = childTraceparent(parentTraceparent || base.traceparent)
  return { ...base, traceparent: outgoing }
}

/** Main thread → worker carrier. Never mutates the caller's message. */
export function wrapForWorker(message, parentTraceparent) {
  const base = message && typeof message === 'object' ? message : {}
  const traceparent = childTraceparent(
    parentTraceparent || base[WORKER_TRACEPARENT_FIELD] || base.trace?.traceparent,
  )
  return {
    ...base,
    [WORKER_TRACE_VERSION_FIELD]: TRACE_WIRE_VERSION,
    [WORKER_TRACEPARENT_FIELD]: traceparent,
  }
}

/**
 * Worker → main-thread receiver. Strips the private fields from the payload
 * and records the worker span as a link (fan-out is never forced as a parent).
 * Messages from pre-#791 workers carry no trace and are returned unchanged.
 */
export function unwrapFromWorker(message) {
  if (!message || typeof message !== 'object') return { message, trace: null }
  const { [WORKER_TRACE_VERSION_FIELD]: version, [WORKER_TRACEPARENT_FIELD]: traceparent, ...rest } = message
  if (version !== TRACE_WIRE_VERSION) return { message: rest, trace: null }
  const ctx = parseTraceparent(traceparent)
  if (!ctx) return { message: rest, trace: null }
  return {
    message: rest,
    trace: {
      v: TRACE_WIRE_VERSION,
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      traceparent: formatTraceparent(ctx),
      links: [{ traceId: ctx.traceId, spanId: ctx.spanId }],
    },
  }
}
