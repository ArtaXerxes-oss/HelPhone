/**
 * #791 cross-layer trace propagation test.
 *
 * Follows ONE traceId from the PWA tap through the HTTP header, the main →
 * worker message, the crash draft, Redis fan-out and finally the indexer audit
 * row. Also asserts the rollback rule: a message with no carrier starts no new
 * trace at any downstream hop.
 *
 * Run with: node --test test/trace-propagation.node-test.mjs
 * (Vitest intentionally ignores *.node-test.mjs — see vite.config.js.)
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatTraceparent,
  parseTraceparent,
  traceHeaders,
  traceIdsFromTraceparent,
  unwrapFromWorker,
  wrapForWorker,
} from '../src/lib/traceWire.js'
import { childTraceparent, extractTrace } from '../server/lib/traceContext.js'
import { publishContractEvent, subscribeContractEvents } from '../server/lib/redisPubSub.js'
import { normalizeContractEvent } from '../server/indexer/auditStreamer.js'

function assertSameTrace(traceparent, traceId, label) {
  const ctx = parseTraceparent(traceparent)
  assert.ok(ctx, `${label}: expected a valid W3C traceparent, got ${traceparent}`)
  assert.equal(ctx.traceId, traceId, `${label}: traceId changed`)
}

test('one dispatch keeps one traceId from PWA tap to indexer row', async () => {
  // 1. PWA tap — the browser creates the origin trace and sends it as a header.
  const httpHeaders = traceHeaders({ 'content-type': 'application/json' })
  const tap = parseTraceparent(httpHeaders.traceparent)
  assert.ok(tap, 'tap produced a valid traceparent')
  assert.equal(httpHeaders['content-type'], 'application/json')
  const traceId = tap.traceId

  // 2. HTTP → server hop — Express forwards a child span on the same trace.
  const serverHop = childTraceparent(httpHeaders.traceparent)
  assertSameTrace(serverHop, traceId, 'HTTP hop')
  assert.notEqual(parseTraceparent(serverHop).spanId, tap.spanId, 'HTTP hop must mint a child span id')

  // 3. Main thread → worker — private fields carry a child of the tap trace.
  const toWorker = wrapForWorker({ op: 'submit_dispatch', dispatchId: 'dispatch-791' }, serverHop)
  assert.equal(toWorker.__traceVersion, 1)
  assertSameTrace(toWorker.__traceparent, traceId, 'worker hop')
  assert.notEqual(parseTraceparent(toWorker.__traceparent).spanId, parseTraceparent(serverHop).spanId)

  // 4. Crash draft — the IDB snapshot stores the very same ids as the worker hop.
  const draftIds = traceIdsFromTraceparent(toWorker.__traceparent)
  assert.deepEqual(draftIds, { traceId, spanId: parseTraceparent(toWorker.__traceparent).spanId })

  // 5. Worker → main thread — the reply becomes a link, not a new parent.
  const fromWorker = unwrapFromWorker({ ...toWorker, result: 'signed' })
  assert.equal(fromWorker.message.result, 'signed')
  assert.equal('__traceparent' in fromWorker.message, false)
  assert.equal(fromWorker.trace.traceId, traceId)
  assert.deepEqual(fromWorker.trace.links, [{ traceId, spanId: draftIds.spanId }])

  // 6. Redis pub/sub — the publisher injects a child span; the subscriber
  //    records that publisher span as a link (fan-out semantics).
  const received = []
  const unsubscribe = subscribeContractEvents((event) => received.push(event))
  try {
    const published = await publishContractEvent(
      {
        topic: 'RqCreated',
        ledger: 12345,
        id: 'evt-791',
        dispatchId: 'dispatch-791',
        txHash: 'tx-791',
        tenantId: 'tenant-a',
      },
      { traceparent: fromWorker.trace.traceparent },
    )
    assert.equal(published, true)
    assert.equal(received.length, 1)

    const event = received[0]
    const carrier = extractTrace(event)
    assert.ok(carrier, 'subscriber received a trace envelope')
    assert.equal(carrier.traceId, traceId)
    assert.notEqual(carrier.spanId, draftIds.spanId, 'publish hop must mint a child span id')
    assert.deepEqual(carrier.links, [{ traceId, spanId: carrier.spanId }])
    assert.equal(event.trace.tracestate, undefined, 'no tracestate was supplied')

    // 7. Indexer row — same traceId, its own span id, and the publisher link.
    const row = normalizeContractEvent(event)
    assert.equal(row.traceparent, carrier.traceparent)
    assert.equal(parseTraceparent(row.traceparent).traceId, traceId)
    assert.match(row.spanId, /^[0-9a-f]{16}$/, 'indexer row has its own span id')
    assert.notEqual(row.spanId, carrier.spanId)
    assert.ok(row.links.some((link) => link.traceId === traceId && link.spanId === carrier.spanId))
    assert.deepEqual(row.attributes, {
      'helphone.dispatch_id': 'dispatch-791',
      'stellar.tx_hash': 'tx-791',
      'stellar.ledger_seq': 12345,
    })
  } finally {
    unsubscribe()
  }
})

test('a message without a trace never starts a new trace', async () => {
  const received = []
  const unsubscribe = subscribeContractEvents((event) => received.push(event))
  try {
    const raw = { topic: 'LocUpd', ledger: 1, id: 'evt-untraced' }
    assert.equal(await publishContractEvent(raw), true)
    assert.equal(received.length, 1)
    assert.equal('trace' in received[0], false, 'pre-#791 publisher message passes through untouched')

    const row = normalizeContractEvent(received[0])
    assert.equal(row.traceparent, null)
    assert.equal(row.spanId, null)
    assert.deepEqual(row.links, [])
    assert.deepEqual(row.attributes, { 'stellar.ledger_seq': 1 })
  } finally {
    unsubscribe()
  }
})

test('an off-chain traceparent alone joins the indexer row', () => {
  const traceparent = formatTraceparent({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) })
  const row = normalizeContractEvent({ id: 'evt-ledger', traceparent, ledger: 7 })
  assert.equal(parseTraceparent(row.traceparent).traceId, 'a'.repeat(32))
  assert.equal(row.links[0].spanId, 'b'.repeat(16))
  assert.equal(row.attributes['stellar.ledger_seq'], 7)
})
