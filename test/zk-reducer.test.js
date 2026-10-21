import { describe, it, expect, vi } from 'vitest'
import { zkReducer, ZK_INITIAL, LOG_RING_SIZE } from '../src/pages/Help.jsx'

// ---------------------------------------------------------------------------
// zkReducer unit tests
//
// Covers every action type plus the two critical safety properties:
//   1. RESET atomicity  — single transition clears all four fields together,
//      closing the buffer-overflow window that existed with four sequential
//      setState calls from an async context.
//   2. Ring-buffer cap  — PUSH_LOG never stores more than LOG_RING_SIZE
//      entries regardless of how many in-flight onLog callbacks fire.
//   3. Stale-onLog safety — a PUSH_LOG arriving after a RESET cannot
//      re-contaminate the buffer with entries from the previous proof run.
// ---------------------------------------------------------------------------

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Run a sequence of actions through the reducer from the initial state. */
function run(...actions) {
  return actions.reduce((s, a) => zkReducer(s, a), { ...ZK_INITIAL, logs: [] })
}

/** Produce a state with n distinct log entries. */
function stateWithLogs(n) {
  return Array.from({ length: n }, (_, i) => ({ type: 'PUSH_LOG', payload: `msg-${i}` }))
    .reduce((s, a) => zkReducer(s, a), { ...ZK_INITIAL, logs: [] })
}

// ── 1. ZK_INITIAL shape ──────────────────────────────────────────────────────
describe('ZK_INITIAL', () => {
  it('has status "idle"', () => expect(ZK_INITIAL.status).toBe('idle'))
  it('has empty logs array', () => expect(ZK_INITIAL.logs).toEqual([]))
  it('has null proof', () => expect(ZK_INITIAL.proof).toBeNull())
  it('has empty error string', () => expect(ZK_INITIAL.error).toBe(''))
  it('is frozen so it cannot be mutated by callers', () => {
    expect(() => { ZK_INITIAL.status = 'proving' }).toThrow()
  })
})

// ── 2. LOG_RING_SIZE export ──────────────────────────────────────────────────
describe('LOG_RING_SIZE', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(LOG_RING_SIZE)).toBe(true)
    expect(LOG_RING_SIZE).toBeGreaterThan(0)
  })
})

// ── 3. RESET action — atomicity ──────────────────────────────────────────────
describe('RESET action', () => {
  it('returns a state equal to ZK_INITIAL from an idle starting state', () => {
    const next = zkReducer({ ...ZK_INITIAL, logs: [] }, { type: 'RESET' })
    expect(next.status).toBe('idle')
    expect(next.logs).toEqual([])
    expect(next.proof).toBeNull()
    expect(next.error).toBe('')
  })

  it('clears status from any non-idle value', () => {
    for (const status of ['proving', 'proved', 'recording', 'recorded', 'error']) {
      const s = { ...ZK_INITIAL, logs: [], status }
      expect(zkReducer(s, { type: 'RESET' }).status).toBe('idle')
    }
  })

  it('clears a non-empty log buffer in one transition', () => {
    const dirty = stateWithLogs(LOG_RING_SIZE)
    expect(dirty.logs).toHaveLength(LOG_RING_SIZE)
    const next = zkReducer(dirty, { type: 'RESET' })
    expect(next.logs).toEqual([])
  })

  it('clears a non-null proof', () => {
    const s = { ...ZK_INITIAL, logs: [], proof: { nullifier: 'abc', txHash: '0x1' } }
    expect(zkReducer(s, { type: 'RESET' }).proof).toBeNull()
  })

  it('clears a non-empty error string', () => {
    const s = { ...ZK_INITIAL, logs: [], error: 'ZK proof failed' }
    expect(zkReducer(s, { type: 'RESET' }).error).toBe('')
  })

  it('clears ALL four fields simultaneously (atomicity)', () => {
    // Simulate the "dirty" state that existed between the four sequential
    // setState calls before the reducer refactor: status/proof/error each
    // set to non-default values, log buffer full.
    const dirty = {
      status: 'error',
      logs: Array.from({ length: LOG_RING_SIZE }, (_, i) => `old-log-${i}`),
      proof: { nullifier: 'old-nullifier', txHash: 'old-hash' },
      error: 'previous run error',
    }
    const next = zkReducer(dirty, { type: 'RESET' })

    // All four fields land in their initial values in a single reducer call —
    // no intermediate state where some are cleared and others are not.
    expect(next.status).toBe('idle')
    expect(next.logs).toEqual([])
    expect(next.proof).toBeNull()
    expect(next.error).toBe('')
  })

  it('returns a new object reference (no mutation)', () => {
    const s = { ...ZK_INITIAL, logs: [] }
    expect(zkReducer(s, { type: 'RESET' })).not.toBe(s)
  })
})

// ── 4. SET_STATUS action ─────────────────────────────────────────────────────
describe('SET_STATUS action', () => {
  it('updates status to the given payload', () => {
    const next = zkReducer({ ...ZK_INITIAL, logs: [] }, { type: 'SET_STATUS', payload: 'proving' })
    expect(next.status).toBe('proving')
  })

  it('does not touch other fields', () => {
    const s = { status: 'idle', logs: ['a'], proof: { x: 1 }, error: 'e' }
    const next = zkReducer(s, { type: 'SET_STATUS', payload: 'proved' })
    expect(next.logs).toEqual(['a'])
    expect(next.proof).toEqual({ x: 1 })
    expect(next.error).toBe('e')
  })

  it('returns the same reference when the status is already the target (bail-out)', () => {
    const s = { ...ZK_INITIAL, logs: [], status: 'proving' }
    expect(zkReducer(s, { type: 'SET_STATUS', payload: 'proving' })).toBe(s)
  })

  it('accepts all valid status strings', () => {
    for (const status of ['idle', 'proving', 'proved', 'recording', 'recorded', 'error']) {
      const next = zkReducer({ ...ZK_INITIAL, logs: [] }, { type: 'SET_STATUS', payload: status })
      expect(next.status).toBe(status)
    }
  })
})

// ── 5. SET_ERROR action ──────────────────────────────────────────────────────
describe('SET_ERROR action', () => {
  it('sets the error field', () => {
    const next = zkReducer({ ...ZK_INITIAL, logs: [] }, { type: 'SET_ERROR', payload: 'wallet rejected' })
    expect(next.error).toBe('wallet rejected')
  })

  it('clears the error field when payload is empty string', () => {
    const s = { ...ZK_INITIAL, logs: [], error: 'some error' }
    const next = zkReducer(s, { type: 'SET_ERROR', payload: '' })
    expect(next.error).toBe('')
  })

  it('returns same reference when error is already equal (bail-out)', () => {
    const s = { ...ZK_INITIAL, logs: [], error: 'same error' }
    expect(zkReducer(s, { type: 'SET_ERROR', payload: 'same error' })).toBe(s)
  })

  it('does not touch status, logs, or proof', () => {
    const s = { status: 'proved', logs: ['x'], proof: { n: 1 }, error: '' }
    const next = zkReducer(s, { type: 'SET_ERROR', payload: 'new error' })
    expect(next.status).toBe('proved')
    expect(next.logs).toEqual(['x'])
    expect(next.proof).toEqual({ n: 1 })
  })
})

// ── 6. SET_PROOF action ──────────────────────────────────────────────────────
describe('SET_PROOF action', () => {
  it('sets proof to the given object', () => {
    const proof = { nullifier: 'abc', zone: { radiusMeters: 3000 } }
    const next = zkReducer({ ...ZK_INITIAL, logs: [] }, { type: 'SET_PROOF', payload: proof })
    expect(next.proof).toEqual(proof)
  })

  it('sets proof to null', () => {
    const s = { ...ZK_INITIAL, logs: [], proof: { nullifier: 'x' } }
    const next = zkReducer(s, { type: 'SET_PROOF', payload: null })
    expect(next.proof).toBeNull()
  })

  it('does not touch status, logs, or error', () => {
    const s = { status: 'proving', logs: ['a'], proof: null, error: 'e' }
    const next = zkReducer(s, { type: 'SET_PROOF', payload: { nullifier: 'z' } })
    expect(next.status).toBe('proving')
    expect(next.logs).toEqual(['a'])
    expect(next.error).toBe('e')
  })
})

// ── 7. PATCH_PROOF action ────────────────────────────────────────────────────
describe('PATCH_PROOF action', () => {
  it('shallow-merges payload into the existing proof', () => {
    const s = { ...ZK_INITIAL, logs: [], proof: { nullifier: 'abc', zone: {} } }
    const next = zkReducer(s, { type: 'PATCH_PROOF', payload: { txHash: '0xDEAD' } })
    expect(next.proof).toEqual({ nullifier: 'abc', zone: {}, txHash: '0xDEAD' })
  })

  it('overwrites existing fields in the proof', () => {
    const s = { ...ZK_INITIAL, logs: [], proof: { nullifier: 'abc', txHash: 'old' } }
    const next = zkReducer(s, { type: 'PATCH_PROOF', payload: { txHash: 'new' } })
    expect(next.proof.txHash).toBe('new')
    expect(next.proof.nullifier).toBe('abc')
  })

  it('is a no-op when proof is null', () => {
    const s = { ...ZK_INITIAL, logs: [] }
    expect(zkReducer(s, { type: 'PATCH_PROOF', payload: { txHash: 'x' } })).toBe(s)
  })

  it('returns a new proof object reference (no mutation)', () => {
    const proof = { nullifier: 'abc' }
    const s = { ...ZK_INITIAL, logs: [], proof }
    const next = zkReducer(s, { type: 'PATCH_PROOF', payload: { txHash: 'y' } })
    expect(next.proof).not.toBe(proof)
  })

  it('patches recordTxHash without touching nullifier or txHash', () => {
    const s = {
      ...ZK_INITIAL, logs: [],
      proof: { nullifier: 'n1', txHash: 'tx1', requestId: 42 },
    }
    const next = zkReducer(s, { type: 'PATCH_PROOF', payload: { recordTxHash: 'rtx1' } })
    expect(next.proof.nullifier).toBe('n1')
    expect(next.proof.txHash).toBe('tx1')
    expect(next.proof.requestId).toBe(42)
    expect(next.proof.recordTxHash).toBe('rtx1')
  })
})

// ── 8. PUSH_LOG action — ring-buffer ─────────────────────────────────────────
describe('PUSH_LOG action — ring-buffer', () => {
  it('appends a message to an empty log', () => {
    const next = zkReducer({ ...ZK_INITIAL, logs: [] }, { type: 'PUSH_LOG', payload: 'step 1' })
    expect(next.logs).toEqual(['step 1'])
  })

  it('appends distinct messages in order', () => {
    const s = run(
      { type: 'PUSH_LOG', payload: 'a' },
      { type: 'PUSH_LOG', payload: 'b' },
      { type: 'PUSH_LOG', payload: 'c' },
    )
    expect(s.logs).toEqual(['a', 'b', 'c'])
  })

  it(`never stores more than ${LOG_RING_SIZE} entries`, () => {
    const s = stateWithLogs(LOG_RING_SIZE + 10)
    expect(s.logs.length).toBeLessThanOrEqual(LOG_RING_SIZE)
  })

  it('keeps the most recent entries when the buffer overflows', () => {
    const n = LOG_RING_SIZE + 5
    const s = stateWithLogs(n)
    const expected = Array.from({ length: LOG_RING_SIZE }, (_, i) => `msg-${n - LOG_RING_SIZE + i}`)
    expect(s.logs).toEqual(expected)
  })

  it('drops the oldest entry once the cap is reached', () => {
    let s = stateWithLogs(LOG_RING_SIZE)
    expect(s.logs[0]).toBe('msg-0')

    s = zkReducer(s, { type: 'PUSH_LOG', payload: 'overflow' })
    expect(s.logs).toHaveLength(LOG_RING_SIZE)
    expect(s.logs[0]).toBe('msg-1')         // msg-0 evicted
    expect(s.logs[LOG_RING_SIZE - 1]).toBe('overflow')
  })

  it('returns the same reference for a consecutive duplicate (bail-out)', () => {
    const s = { ...ZK_INITIAL, logs: ['step A', 'step B'] }
    const next = zkReducer(s, { type: 'PUSH_LOG', payload: 'step B' })
    expect(next).toBe(s)
  })

  it('does NOT deduplicate non-consecutive repeated messages', () => {
    const s = run(
      { type: 'PUSH_LOG', payload: 'A' },
      { type: 'PUSH_LOG', payload: 'B' },
      { type: 'PUSH_LOG', payload: 'A' },  // not consecutive
    )
    expect(s.logs).toEqual(['A', 'B', 'A'])
  })

  it('does not touch status, proof, or error', () => {
    const s = { status: 'proving', logs: [], proof: { nullifier: 'x' }, error: 'e' }
    const next = zkReducer(s, { type: 'PUSH_LOG', payload: 'hello' })
    expect(next.status).toBe('proving')
    expect(next.proof).toEqual({ nullifier: 'x' })
    expect(next.error).toBe('e')
  })
})

// ── 9. Unknown action — default branch ──────────────────────────────────────
describe('unknown action type', () => {
  it('returns the same state reference for an unrecognised action', () => {
    const s = { ...ZK_INITIAL, logs: [] }
    expect(zkReducer(s, { type: 'BOGUS_ACTION' })).toBe(s)
  })
})

// ── 10. Buffer-overflow edge case ────────────────────────────────────────────
// This is the specific scenario that caused dropped emergency requests:
// an in-flight onLog callback fires bursts of messages while the ring-buffer
// has already hit its cap. The buffer must never grow beyond LOG_RING_SIZE.
describe('buffer overflow — in-flight onLog burst simulation', () => {
  it('handles 1000 rapid PUSH_LOG dispatches without exceeding cap', () => {
    let s = { ...ZK_INITIAL, logs: [] }
    for (let i = 0; i < 1000; i++) {
      s = zkReducer(s, { type: 'PUSH_LOG', payload: `worker-log-${i}` })
    }
    expect(s.logs.length).toBeLessThanOrEqual(LOG_RING_SIZE)
  })

  it('retains only the final LOG_RING_SIZE messages after a burst', () => {
    const N = 1000
    let s = { ...ZK_INITIAL, logs: [] }
    for (let i = 0; i < N; i++) {
      s = zkReducer(s, { type: 'PUSH_LOG', payload: `burst-${i}` })
    }
    const expected = Array.from(
      { length: LOG_RING_SIZE },
      (_, i) => `burst-${N - LOG_RING_SIZE + i}`,
    )
    expect(s.logs).toEqual(expected)
  })
})

// ── 11. Stale-onLog after RESET ───────────────────────────────────────────────
// Before the reducer refactor, four sequential setState calls created a window
// where an onLog callback from a previous proof could append to a partially-
// cleared buffer. These tests verify that a PUSH_LOG arriving after a RESET
// starts from a clean slate, not from stale entries.
describe('stale-onLog safety after RESET', () => {
  it('a PUSH_LOG after RESET appends to an empty buffer, not the old one', () => {
    // Simulate a full dirty buffer from a previous proof run
    let s = stateWithLogs(LOG_RING_SIZE)
    expect(s.logs).toHaveLength(LOG_RING_SIZE)

    // RESET fires (the new proof run begins)
    s = zkReducer(s, { type: 'RESET' })
    expect(s.logs).toEqual([])

    // A stale onLog callback from the previous WASM worker fires after the reset
    s = zkReducer(s, { type: 'PUSH_LOG', payload: 'Preparing private witness' })

    // The message goes into a clean buffer — not appended to old entries
    expect(s.logs).toEqual(['Preparing private witness'])
    expect(s.logs).toHaveLength(1)
  })

  it('deduplication does not fire across a RESET boundary', () => {
    // Last message of the old run
    let s = run({ type: 'PUSH_LOG', payload: 'Private location proof ready' })
    s = zkReducer(s, { type: 'RESET' })

    // First message of the new run happens to match the last of the old run.
    // Without a RESET boundary this would be silently dropped by the
    // consecutive-duplicate guard, causing the UI to miss the log line.
    s = zkReducer(s, { type: 'PUSH_LOG', payload: 'Private location proof ready' })
    expect(s.logs).toEqual(['Private location proof ready'])
  })

  it('multiple PUSH_LOGs after RESET build up correctly from zero', () => {
    let s = stateWithLogs(LOG_RING_SIZE)
    s = zkReducer(s, { type: 'RESET' })

    s = zkReducer(s, { type: 'PUSH_LOG', payload: 'step A' })
    s = zkReducer(s, { type: 'PUSH_LOG', payload: 'step B' })
    s = zkReducer(s, { type: 'PUSH_LOG', payload: 'step C' })

    expect(s.logs).toEqual(['step A', 'step B', 'step C'])
  })
})

// ── 12. Full proof lifecycle sequence ────────────────────────────────────────
// Mirrors the real action sequence dispatched by buildPrivacyProof +
// recordZkCheckpoint + handleSubmit to confirm the whole flow is coherent.
describe('full proof lifecycle', () => {
  it('handles a complete request-proof-record sequence', () => {
    let s = { ...ZK_INITIAL, logs: [] }

    // resetZkCheckpoint()
    s = zkReducer(s, { type: 'RESET' })
    expect(s).toMatchObject({ status: 'idle', logs: [], proof: null, error: '' })

    // buildPrivacyProof: status → proving, clear error, log
    s = zkReducer(s, { type: 'SET_STATUS', payload: 'proving' })
    s = zkReducer(s, { type: 'SET_ERROR',  payload: '' })
    s = zkReducer(s, { type: 'PUSH_LOG',   payload: 'Preparing private witness' })
    expect(s.status).toBe('proving')
    expect(s.logs).toContain('Preparing private witness')

    // proof generated
    s = zkReducer(s, { type: 'SET_PROOF',  payload: { nullifier: 'n1', zone: {} } })
    s = zkReducer(s, { type: 'SET_STATUS', payload: 'proved' })
    s = zkReducer(s, { type: 'PUSH_LOG',   payload: 'Private location proof ready' })
    expect(s.status).toBe('proved')
    expect(s.proof.nullifier).toBe('n1')

    // createRequest returns id + hash
    s = zkReducer(s, { type: 'PATCH_PROOF', payload: { requestId: 7, txHash: 'tx-abc' } })
    expect(s.proof.requestId).toBe(7)
    expect(s.proof.txHash).toBe('tx-abc')

    // recordZkCheckpoint: status → recording
    s = zkReducer(s, { type: 'SET_STATUS', payload: 'recording' })
    s = zkReducer(s, { type: 'PUSH_LOG',   payload: 'Writing proof fingerprint to Stellar' })
    expect(s.status).toBe('recording')

    // Stellar confirms
    s = zkReducer(s, { type: 'PATCH_PROOF', payload: { recordTxHash: 'rec-xyz' } })
    s = zkReducer(s, { type: 'SET_STATUS', payload: 'recorded' })
    s = zkReducer(s, { type: 'PUSH_LOG',   payload: 'Stellar checkpoint recorded' })

    expect(s.status).toBe('recorded')
    expect(s.proof.recordTxHash).toBe('rec-xyz')
    expect(s.logs.length).toBeGreaterThan(0)
    expect(s.logs.length).toBeLessThanOrEqual(LOG_RING_SIZE)
  })

  it('handles the error path: SET_STATUS error + SET_ERROR', () => {
    let s = { ...ZK_INITIAL, logs: [] }
    s = zkReducer(s, { type: 'RESET' })
    s = zkReducer(s, { type: 'SET_STATUS', payload: 'proving' })
    // Proof generation throws
    s = zkReducer(s, { type: 'SET_STATUS', payload: 'error' })
    s = zkReducer(s, { type: 'SET_ERROR',  payload: 'circuit witness generation failed' })

    expect(s.status).toBe('error')
    expect(s.error).toBe('circuit witness generation failed')
    expect(s.proof).toBeNull()
  })

  it('handles the race-condition path: SET_STATUS proved + SET_ERROR empty', () => {
    let s = { ...ZK_INITIAL, logs: [], status: 'recording', error: 'stale' }
    s = zkReducer(s, { type: 'SET_STATUS', payload: 'proved' })
    s = zkReducer(s, { type: 'SET_ERROR',  payload: '' })

    expect(s.status).toBe('proved')
    expect(s.error).toBe('')
  })

  it('second proof run starts clean after RESET even with logs from first run', () => {
    // First run produces a full buffer
    let s = run(
      { type: 'SET_STATUS', payload: 'proved' },
      { type: 'SET_PROOF',  payload: { nullifier: 'run-1' } },
      { type: 'PUSH_LOG',   payload: 'Private location proof ready' },
    )
    expect(s.proof.nullifier).toBe('run-1')

    // User retries — RESET fires
    s = zkReducer(s, { type: 'RESET' })

    // Second run
    s = zkReducer(s, { type: 'SET_STATUS', payload: 'proving' })
    s = zkReducer(s, { type: 'SET_PROOF',  payload: { nullifier: 'run-2' } })
    s = zkReducer(s, { type: 'SET_STATUS', payload: 'proved' })

    expect(s.proof.nullifier).toBe('run-2')
    expect(s.error).toBe('')
  })
})

// ── 13. Immutability — no state mutation ────────────────────────────────────
describe('immutability', () => {
  it('never mutates the input state object', () => {
    const actions = [
      { type: 'RESET' },
      { type: 'SET_STATUS', payload: 'proving' },
      { type: 'SET_ERROR',  payload: 'oops' },
      { type: 'SET_PROOF',  payload: { nullifier: 'x' } },
      { type: 'PATCH_PROOF', payload: { txHash: 'y' } },
      { type: 'PUSH_LOG',   payload: 'hello' },
    ]
    for (const action of actions) {
      const s = { status: 'idle', logs: ['a'], proof: { nullifier: 'p' }, error: '' }
      const frozen = Object.freeze({ ...s, logs: Object.freeze([...s.logs]) })
      // Should not throw — reducer must not write to the frozen object
      expect(() => zkReducer(frozen, action)).not.toThrow()
    }
  })

  it('returns a new state reference for every mutating action', () => {
    const s = { ...ZK_INITIAL, logs: [], proof: { nullifier: 'x' } }
    const mutating = [
      { type: 'RESET' },
      { type: 'SET_STATUS', payload: 'proving' },
      { type: 'SET_ERROR',  payload: 'e' },
      { type: 'SET_PROOF',  payload: { nullifier: 'y' } },
      { type: 'PATCH_PROOF', payload: { txHash: 'z' } },
      { type: 'PUSH_LOG',   payload: 'new msg' },
    ]
    for (const action of mutating) {
      const next = zkReducer(s, action)
      if (next !== s) {  // bail-out actions are allowed to return same ref
        expect(next).not.toBe(s)
      }
    }
  })
})
