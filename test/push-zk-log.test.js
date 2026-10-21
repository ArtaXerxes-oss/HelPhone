import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// pushZkLog type-assertion & ring-buffer tests
//
// The function lives inside a React component, so we extract the pure logic
// (coercion + ring-buffer update) into a standalone helper that mirrors the
// production implementation exactly.  This lets us assert every edge-case
// without mounting the full component.
// ---------------------------------------------------------------------------

const LOG_RING_SIZE = 6

/**
 * Pure equivalent of the production pushZkLog state updater.
 * Returns the next log array given the previous one and a raw message,
 * applying the same coercion, deduplication, and ring-buffer rules.
 */
function applyPushZkLog(prev, message) {
  // ── Type assertion ────────────────────────────────────────────────────
  let safe
  if (message === null || message === undefined) return prev          // no-op
  if (message instanceof Error) {
    safe = message.message || message.toString()
  } else if (typeof message === 'object') {
    try { safe = JSON.stringify(message) } catch { safe = String(message) }
  } else {
    safe = String(message)
  }

  safe = safe.trim()
  if (!safe) return prev                                              // no-op

  // ── Ring-buffer update with deduplication ────────────────────────────
  if (prev.length > 0 && prev[prev.length - 1] === safe) return prev // deduplicate
  return [...prev.slice(-(LOG_RING_SIZE - 1)), safe]
}

/** Convenience: run applyPushZkLog over an array of messages from [] */
function buildLog(messages) {
  return messages.reduce((acc, msg) => applyPushZkLog(acc, msg), [])
}

// ---------------------------------------------------------------------------
describe('pushZkLog — type assertions & ring-buffer', () => {

  // ── 1. Happy-path string inputs ─────────────────────────────────────────
  describe('valid string input', () => {
    it('appends a plain string to an empty log', () => {
      const result = applyPushZkLog([], 'Preparing private witness')
      expect(result).toEqual(['Preparing private witness'])
    })

    it('appends multiple distinct strings in order', () => {
      const result = buildLog(['step A', 'step B', 'step C'])
      expect(result).toEqual(['step A', 'step B', 'step C'])
    })

    it('trims leading and trailing whitespace', () => {
      const result = applyPushZkLog([], '  padded message  ')
      expect(result).toEqual(['padded message'])
    })

    it('preserves internal whitespace', () => {
      const result = applyPushZkLog([], 'ZK proof   building')
      expect(result).toEqual(['ZK proof   building'])
    })
  })

  // ── 2. Null / undefined — silent no-op ──────────────────────────────────
  describe('null and undefined inputs', () => {
    it('returns the same array reference for null (no-op)', () => {
      const prev = ['existing']
      const result = applyPushZkLog(prev, null)
      expect(result).toBe(prev)
    })

    it('returns the same array reference for undefined (no-op)', () => {
      const prev = ['existing']
      const result = applyPushZkLog(prev, undefined)
      expect(result).toBe(prev)
    })

    it('does not append null to an empty log', () => {
      expect(applyPushZkLog([], null)).toEqual([])
    })

    it('does not append undefined to an empty log', () => {
      expect(applyPushZkLog([], undefined)).toEqual([])
    })
  })

  // ── 3. Empty / blank strings — silent no-op ─────────────────────────────
  describe('empty and blank string inputs', () => {
    it('returns the same array reference for an empty string (no-op)', () => {
      const prev = ['existing']
      const result = applyPushZkLog(prev, '')
      expect(result).toBe(prev)
    })

    it('returns the same array reference for a whitespace-only string (no-op)', () => {
      const prev = ['existing']
      const result = applyPushZkLog(prev, '   ')
      expect(result).toBe(prev)
    })

    it('does not append empty string to an empty log', () => {
      expect(applyPushZkLog([], '')).toEqual([])
    })
  })

  // ── 4. Error instances ───────────────────────────────────────────────────
  describe('Error instance inputs', () => {
    it('extracts message from a standard Error', () => {
      const result = applyPushZkLog([], new Error('circuit constraint failed'))
      expect(result).toEqual(['circuit constraint failed'])
    })

    it('falls back to toString() when error.message is empty', () => {
      const err = new Error('')
      const result = applyPushZkLog([], err)
      // Error('').toString() === 'Error'
      expect(result[0]).toMatch(/Error/)
    })

    it('handles RangeError, TypeError, etc.', () => {
      const result = applyPushZkLog([], new RangeError('value out of bounds'))
      expect(result).toEqual(['value out of bounds'])
    })

    it('handles an Error with no message property', () => {
      const err = Object.create(Error.prototype)
      err.message = ''
      const result = applyPushZkLog([], err)
      expect(result[0]).toBeTruthy()  // some non-empty fallback
    })
  })

  // ── 5. Plain objects ─────────────────────────────────────────────────────
  describe('plain object inputs', () => {
    it('JSON-stringifies a plain object', () => {
      const result = applyPushZkLog([], { code: 42, step: 'witness' })
      expect(result).toEqual(['{"code":42,"step":"witness"}'])
    })

    it('JSON-stringifies an array', () => {
      const result = applyPushZkLog([], [1, 2, 3])
      expect(result).toEqual(['[1,2,3]'])
    })

    it('falls back to String() for a non-serialisable object', () => {
      // Circular reference causes JSON.stringify to throw
      const circular = {}
      circular.self = circular
      const result = applyPushZkLog([], circular)
      expect(result).toHaveLength(1)
      expect(typeof result[0]).toBe('string')
      expect(result[0]).not.toBe('')
    })

    it('handles an empty object', () => {
      const result = applyPushZkLog([], {})
      expect(result).toEqual(['{}'])
    })
  })

  // ── 6. Primitive non-string types ────────────────────────────────────────
  describe('primitive non-string inputs', () => {
    it('converts a number to string', () => {
      expect(applyPushZkLog([], 42)).toEqual(['42'])
    })

    it('converts 0 to string "0"', () => {
      expect(applyPushZkLog([], 0)).toEqual(['0'])
    })

    it('converts true/false to string', () => {
      expect(applyPushZkLog([], true)).toEqual(['true'])
      expect(applyPushZkLog([], false)).toEqual(['false'])
    })

    it('converts NaN to string "NaN"', () => {
      expect(applyPushZkLog([], NaN)).toEqual(['NaN'])
    })

    it('converts Infinity to string', () => {
      expect(applyPushZkLog([], Infinity)).toEqual(['Infinity'])
    })
  })

  // ── 7. Ring-buffer capping ───────────────────────────────────────────────
  describe('ring-buffer capping', () => {
    it(`never exceeds ${LOG_RING_SIZE} entries`, () => {
      const messages = Array.from({ length: 20 }, (_, i) => `step ${i}`)
      const result = buildLog(messages)
      expect(result.length).toBeLessThanOrEqual(LOG_RING_SIZE)
    })

    it('keeps the most recent entries when the buffer overflows', () => {
      const messages = Array.from({ length: 20 }, (_, i) => `msg-${i}`)
      const result = buildLog(messages)
      const last = messages.slice(-LOG_RING_SIZE)
      expect(result).toEqual(last)
    })

    it('starts dropping oldest entries once the buffer is full', () => {
      const base = Array.from({ length: LOG_RING_SIZE }, (_, i) => `old-${i}`)
      let log = buildLog(base)
      expect(log).toHaveLength(LOG_RING_SIZE)

      log = applyPushZkLog(log, 'new-entry')
      expect(log).toHaveLength(LOG_RING_SIZE)
      expect(log[log.length - 1]).toBe('new-entry')
      expect(log[0]).toBe('old-1')  // old-0 was dropped
    })

    it('handles exactly LOG_RING_SIZE messages without dropping any', () => {
      const messages = Array.from({ length: LOG_RING_SIZE }, (_, i) => `step-${i}`)
      const result = buildLog(messages)
      expect(result).toHaveLength(LOG_RING_SIZE)
      expect(result).toEqual(messages)
    })
  })

  // ── 8. Deduplication ─────────────────────────────────────────────────────
  describe('consecutive deduplication', () => {
    it('returns the same array reference for an identical consecutive message', () => {
      const prev = ['step A', 'step B']
      const result = applyPushZkLog(prev, 'step B')
      expect(result).toBe(prev)
    })

    it('does NOT deduplicate non-consecutive repeated messages', () => {
      const result = buildLog(['step A', 'step B', 'step A'])
      expect(result).toEqual(['step A', 'step B', 'step A'])
    })

    it('appends the same message after a different message appears', () => {
      const prev = ['step A', 'step B']
      const r1 = applyPushZkLog(prev, 'step A')  // not consecutive — should append
      expect(r1).toEqual(['step A', 'step B', 'step A'])
    })

    it('handles 1000 identical consecutive calls without growing the log', () => {
      let log = []
      for (let i = 0; i < 1000; i++) {
        log = applyPushZkLog(log, 'same message')
      }
      expect(log).toHaveLength(1)
    })
  })

  // ── 9. Immutability — no mutation of previous array ──────────────────────
  describe('immutability', () => {
    it('returns a new array reference when appending', () => {
      const prev = ['existing']
      const result = applyPushZkLog(prev, 'new')
      expect(result).not.toBe(prev)
    })

    it('does not mutate the previous array', () => {
      const prev = ['a', 'b']
      const frozen = Object.freeze([...prev])
      // Should not throw even on a frozen array because we never mutate
      expect(() => applyPushZkLog(frozen, 'c')).not.toThrow()
    })
  })

  // ── 10. onLog callback contract (external caller simulation) ─────────────
  describe('onLog callback — external caller simulation', () => {
    it('handles values that a WASM/worker might emit: number progress', () => {
      // WASM workers sometimes emit numeric progress values
      const result = applyPushZkLog([], 99)
      expect(result).toEqual(['99'])
    })

    it('handles values that a WASM/worker might emit: Error object', () => {
      const result = applyPushZkLog([], new Error('witness generation failed'))
      expect(result).toEqual(['witness generation failed'])
    })

    it('handles values that a WASM/worker might emit: status object', () => {
      const result = applyPushZkLog([], { type: 'progress', pct: 50 })
      expect(result[0]).toContain('progress')
    })

    it('does not panic on a deeply nested object', () => {
      const deep = { a: { b: { c: { d: 'deep' } } } }
      expect(() => applyPushZkLog([], deep)).not.toThrow()
      const result = applyPushZkLog([], deep)
      expect(result).toHaveLength(1)
    })

    it('does not panic when called with Symbol (non-serialisable primitive)', () => {
      // Symbol() cannot be JSON.stringified or implicitly converted to string
      // without throwing in strict mode; String() handles it safely.
      const sym = Symbol('zk-event')
      expect(() => applyPushZkLog([], sym)).not.toThrow()
      // String(Symbol('zk-event')) === 'Symbol(zk-event)'
      const result = applyPushZkLog([], sym)
      expect(result[0]).toContain('Symbol')
    })
  })
})
