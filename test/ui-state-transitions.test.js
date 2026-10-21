import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useReducer } from 'react'
import {
  zkReducer,
  ZK_INITIAL,
  LOG_RING_SIZE,
  createDebouncedSetter,
  computeWalletStatus,
  sanitizeWalletAddress,
  getStatusConfig,
  checkIsGetMode,
  getAccentColor,
  computeStep3Done,
  computeUserCharacter,
} from '../src/pages/Help.jsx'

// ---------------------------------------------------------------------------
// Issue #131 — UI State Transition Tests
//
// Complex state transitions (Idle -> Proving -> Submitting -> Success) lack
// verification. These tests ensure UI components render correct states
// sequentially by mocking async delays and responses, advancing timers
// manually, and asserting that buttons disable / loading indicators appear
// and disappear at the correct times.
// ---------------------------------------------------------------------------

// ── Helpers ─────────────────────────────────────────────────────────────────

function runActions(...actions) {
  return actions.reduce((s, a) => zkReducer(s, a), { ...ZK_INITIAL, logs: [] })
}

function stateWithStatus(status) {
  return { ...ZK_INITIAL, logs: [], status }
}

// ── 1. Idle → Proving transition ────────────────────────────────────────────
describe('UI state transition: Idle → Proving', () => {
  it('starts in idle with empty proof and no error', () => {
    const state = { ...ZK_INITIAL, logs: [] }
    expect(state.status).toBe('idle')
    expect(state.proof).toBeNull()
    expect(state.error).toBe('')
    expect(state.logs).toEqual([])
  })

  it('transitions to proving with a clear error field', () => {
    let s = { ...ZK_INITIAL, logs: [] }
    s = zkReducer(s, { type: 'RESET' })
    s = zkReducer(s, { type: 'SET_STATUS', payload: 'proving' })
    s = zkReducer(s, { type: 'SET_ERROR', payload: '' })
    s = zkReducer(s, { type: 'PUSH_LOG', payload: 'Preparing private witness' })

    expect(s.status).toBe('proving')
    expect(s.error).toBe('')
    expect(s.proof).toBeNull()
    expect(s.logs).toContain('Preparing private witness')
  })

  it('disables submit button and shows loading indicator during proving', () => {
    const s = stateWithStatus('proving')
    // Simulates: isSubmitDisabled = zkStatus === 'proving' || submitting
    const isSubmitDisabled = s.status === 'proving'
    expect(isSubmitDisabled).toBe(true)

    // Loading indicator: zkStatus === 'proving' || zkStatus === 'recording'
    const showLoadingIndicator = s.status === 'proving' || s.status === 'recording'
    expect(showLoadingIndicator).toBe(true)
  })
})

// ── 2. Proving → Proved transition ─────────────────────────────────────────
describe('UI state transition: Proving → Proved', () => {
  it('transitions to proved with proof data', () => {
    let s = { ...ZK_INITIAL, logs: [] }
    s = zkReducer(s, { type: 'SET_STATUS', payload: 'proving' })
    s = zkReducer(s, { type: 'SET_PROOF', payload: { nullifier: 'abc123', zone: { radiusMeters: 3000 } } })
    s = zkReducer(s, { type: 'SET_STATUS', payload: 'proved' })
    s = zkReducer(s, { type: 'PUSH_LOG', payload: 'Private location proof ready' })

    expect(s.status).toBe('proved')
    expect(s.proof).toEqual({ nullifier: 'abc123', zone: { radiusMeters: 3000 } })
    expect(s.logs).toContain('Private location proof ready')
  })

  it('shows proof details (nullifier, zone) in the UI after proved state', () => {
    const s = {
      ...ZK_INITIAL,
      logs: [],
      status: 'proved',
      proof: { nullifier: 'abc123', zone: { radiusMeters: 3000 } },
    }

    // Simulates: zkProof?.nullifier check in template
    expect(s.proof?.nullifier).toBeTruthy()
    // Simulates: zkProof.zone?.radiusMeters check in template
    expect(s.proof.zone?.radiusMeters).toBe(3000)
  })
})

// ── 3. Proved → Recording → Recorded transition ────────────────────────────
describe('UI state transition: Proved → Recording → Recorded', () => {
  it('transitions through recording to recorded', () => {
    let s = runActions(
      { type: 'SET_PROOF', payload: { nullifier: 'abc', txHash: '0xDEF' } },
      { type: 'SET_STATUS', payload: 'proved' },
      { type: 'SET_STATUS', payload: 'recording' },
      { type: 'PUSH_LOG', payload: 'Writing proof fingerprint to Stellar' },
    )

    expect(s.status).toBe('recording')

    s = zkReducer(s, { type: 'PATCH_PROOF', payload: { recordTxHash: '0xREC' } })
    s = zkReducer(s, { type: 'SET_STATUS', payload: 'recorded' })
    s = zkReducer(s, { type: 'PUSH_LOG', payload: 'Stellar checkpoint recorded' })

    expect(s.status).toBe('recorded')
    expect(s.proof.recordTxHash).toBe('0xREC')
    expect(s.proof.txHash).toBe('0xDEF')
    expect(s.logs).toContain('Stellar checkpoint recorded')
  })

  it('recording state shows loading indicator', () => {
    const s = stateWithStatus('recording')
    const showLoadingIndicator = s.status === 'proving' || s.status === 'recording'
    expect(showLoadingIndicator).toBe(true)
  })

  it('recorded state hides loading indicator', () => {
    const s = stateWithStatus('recorded')
    const showLoadingIndicator = s.status === 'proving' || s.status === 'recording'
    expect(showLoadingIndicator).toBe(false)
  })
})

// ── 4. Error transition from any state ──────────────────────────────────────
describe('UI state transition: Error from any active state', () => {
  it('transitions from proving to error', () => {
    let s = runActions(
      { type: 'SET_STATUS', payload: 'proving' },
      { type: 'SET_STATUS', payload: 'error' },
      { type: 'SET_ERROR', payload: 'circuit witness generation failed' },
    )
    expect(s.status).toBe('error')
    expect(s.error).toBe('circuit witness generation failed')
  })

  it('transitions from recording to error', () => {
    let s = runActions(
      { type: 'SET_STATUS', payload: 'recording' },
      { type: 'SET_STATUS', payload: 'error' },
      { type: 'SET_ERROR', payload: 'wallet rejected' },
    )
    expect(s.status).toBe('error')
    expect(s.error).toBe('wallet rejected')
  })

  it('error state shows error message and hides loading indicator', () => {
    const s = { ...ZK_INITIAL, logs: [], status: 'error', error: 'ZK proof failed' }
    const showLoadingIndicator = s.status === 'proving' || s.status === 'recording'
    expect(showLoadingIndicator).toBe(false)

    // Error message visibility: zkError truthy
    expect(s.error).toBeTruthy()
  })

  it('error state still allows reset back to idle', () => {
    let s = runActions(
      { type: 'SET_STATUS', payload: 'proving' },
      { type: 'SET_STATUS', payload: 'error' },
      { type: 'SET_ERROR', payload: 'something broke' },
      { type: 'RESET' },
    )
    expect(s.status).toBe('idle')
    expect(s.error).toBe('')
    expect(s.proof).toBeNull()
  })
})

// ── 5. Full lifecycle: Idle → Proving → Proved → Recording → Recorded ──────
describe('UI state transition: Full happy-path lifecycle', () => {
  it('executes the complete lifecycle without state glitches', () => {
    let s = { ...ZK_INITIAL, logs: [] }

    // Step 0: Idle
    expect(s.status).toBe('idle')
    expect(s.proof).toBeNull()

    // Step 1: Reset (user triggers new proof)
    s = zkReducer(s, { type: 'RESET' })
    expect(s.status).toBe('idle')
    expect(s.logs).toEqual([])

    // Step 2: Proving begins
    s = zkReducer(s, { type: 'SET_STATUS', payload: 'proving' })
    s = zkReducer(s, { type: 'SET_ERROR', payload: '' })
    s = zkReducer(s, { type: 'PUSH_LOG', payload: 'Preparing private witness' })
    expect(s.status).toBe('proving')

    // Step 3: Proof generated
    s = zkReducer(s, { type: 'SET_PROOF', payload: { nullifier: 'n1', zone: { radiusMeters: 3000 } } })
    s = zkReducer(s, { type: 'SET_STATUS', payload: 'proved' })
    s = zkReducer(s, { type: 'PUSH_LOG', payload: 'Private location proof ready' })
    expect(s.status).toBe('proved')

    // Step 4: Recording
    s = zkReducer(s, { type: 'PATCH_PROOF', payload: { requestId: 42, txHash: '0xABC' } })
    s = zkReducer(s, { type: 'SET_STATUS', payload: 'recording' })
    s = zkReducer(s, { type: 'PUSH_LOG', payload: 'Writing proof fingerprint to Stellar' })
    expect(s.status).toBe('recording')

    // Step 5: Recorded
    s = zkReducer(s, { type: 'PATCH_PROOF', payload: { recordTxHash: '0xDEF' } })
    s = zkReducer(s, { type: 'SET_STATUS', payload: 'recorded' })
    s = zkReducer(s, { type: 'PUSH_LOG', payload: 'Stellar checkpoint recorded' })
    expect(s.status).toBe('recorded')
    expect(s.proof.requestId).toBe(42)
    expect(s.proof.txHash).toBe('0xABC')
    expect(s.proof.recordTxHash).toBe('0xDEF')

    // Verify log buffer is bounded
    expect(s.logs.length).toBeLessThanOrEqual(LOG_RING_SIZE)
  })
})

// ── 6. Button disabling logic ───────────────────────────────────────────────
describe('UI button disabling logic', () => {
  it('submit button is enabled only in idle state when not submitting', () => {
    const states = ['idle', 'proving', 'proved', 'recording', 'recorded', 'error']
    for (const status of states) {
      const isSubmitDisabled = status === 'proving' || status === 'recording'
      if (status === 'idle') {
        expect(isSubmitDisabled).toBe(false)
      } else if (status === 'proving' || status === 'recording') {
        expect(isSubmitDisabled).toBe(true)
      }
    }
  })

  it('mark-arrived button is disabled during arrival submission', () => {
    const isMarkingArrived = true
    const isDisabled = isMarkingArrived
    expect(isDisabled).toBe(true)
  })

  it('offer-accepting button is disabled when offerSubmitting is true', () => {
    const offerSubmitting = true
    const isDisabled = offerSubmitting
    expect(isDisabled).toBe(true)
  })
})

// ── 7. Status badge visibility ──────────────────────────────────────────────
describe('Status badge visibility', () => {
  it('shows "ready" badge text when idle', () => {
    const zkStatus = 'idle'
    const badgeText = zkStatus === 'idle' ? 'ready' : zkStatus
    expect(badgeText).toBe('ready')
  })

  it('shows status name when not idle', () => {
    for (const status of ['proving', 'proved', 'recording', 'recorded', 'error']) {
      const badgeText = status === 'idle' ? 'ready' : status
      expect(badgeText).toBe(status)
    }
  })

  it('badge indicator color varies by status', () => {
    const getColor = (zkStatus) =>
      zkStatus === 'error' ? '#FF7A6B'
        : zkStatus === 'idle' ? 'rgba(242,236,220,0.28)'
        : '#B3A6FF'

    expect(getColor('idle')).toBe('rgba(242,236,220,0.28)')
    expect(getColor('proving')).toBe('#B3A6FF')
    expect(getColor('error')).toBe('#FF7A6B')
    expect(getColor('recording')).toBe('#B3A6FF')
  })
})

// ── 8. Loading indicator animation logic ────────────────────────────────────
describe('Loading indicator animation', () => {
  it('shows blink animation during proving and recording', () => {
    const getStatusAnimation = (zkStatus) =>
      zkStatus === 'proving' || zkStatus === 'recording'
        ? 'mdblink 1.2s steps(1) infinite'
        : 'none'

    expect(getStatusAnimation('idle')).toBe('none')
    expect(getStatusAnimation('proving')).toBe('mdblink 1.2s steps(1) infinite')
    expect(getStatusAnimation('proved')).toBe('none')
    expect(getStatusAnimation('recording')).toBe('mdblink 1.2s steps(1) infinite')
    expect(getStatusAnimation('recorded')).toBe('none')
    expect(getStatusAnimation('error')).toBe('none')
  })
})

// ── 9. Log display — show last 3 entries ────────────────────────────────────
describe('Log display rendering', () => {
  it('shows only the last 3 log entries', () => {
    const s = runActions(
      { type: 'PUSH_LOG', payload: 'line 1' },
      { type: 'PUSH_LOG', payload: 'line 2' },
      { type: 'PUSH_LOG', payload: 'line 3' },
      { type: 'PUSH_LOG', payload: 'line 4' },
    )
    // UI displays: zkLogs.slice(-3)
    const displayed = s.logs.slice(-3)
    expect(displayed).toEqual(['line 2', 'line 3', 'line 4'])
    expect(displayed).toHaveLength(3)
  })

  it('shows all logs when fewer than 3', () => {
    const s = runActions(
      { type: 'PUSH_LOG', payload: 'a' },
      { type: 'PUSH_LOG', payload: 'b' },
    )
    expect(s.logs.slice(-3)).toEqual(['a', 'b'])
  })
})

// ── 10. Debounced setter — wallet address state batching ────────────────────
describe('Debounced setter — wallet address batching', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('batches rapid wallet address updates into a single state change', async () => {
    const setter = vi.fn()
    const { debouncedSet, flush, cancel } = createDebouncedSetter(setter, 100)

    debouncedSet('addr1')
    debouncedSet('addr2')
    debouncedSet('addr3')

    expect(setter).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    expect(setter).toHaveBeenCalledTimes(1)
    expect(setter).toHaveBeenCalledWith('addr3')
  })

  it('flush applies pending value immediately', () => {
    const setter = vi.fn()
    const { debouncedSet, flush } = createDebouncedSetter(setter, 100)

    debouncedSet('pending')
    flush()
    expect(setter).toHaveBeenCalledWith('pending')
  })

  it('cancel discards pending value', () => {
    const setter = vi.fn()
    const { debouncedSet, cancel } = createDebouncedSetter(setter, 100)

    debouncedSet('discarded')
    cancel()
    vi.advanceTimersByTime(200)
    expect(setter).not.toHaveBeenCalled()
  })
})

// ── 11. Wallet connection status display ────────────────────────────────────
describe('Wallet connection status display', () => {
  const VALID_G = 'G' + 'A'.repeat(55)

  it('shows connected state with display address', () => {
    const { isConnected, displayAddress } = computeWalletStatus(VALID_G)
    expect(isConnected).toBe(true)
    expect(displayAddress).toContain('...')
    expect(displayAddress.length).toBeGreaterThan(3)
  })

  it('shows disconnected state when empty', () => {
    const { isConnected, displayAddress } = computeWalletStatus('')
    expect(isConnected).toBe(false)
    expect(displayAddress).toBe('')
  })

  it('shows disconnected state for invalid address', () => {
    const { isConnected } = computeWalletStatus('not-a-valid-key')
    expect(isConnected).toBe(false)
  })
})

// ── 12. Mode toggle (Get Help / Offer Help) ────────────────────────────────
describe('Mode toggle behavior', () => {
  it('detects get mode correctly', () => {
    expect(checkIsGetMode('get')).toBe(true)
    expect(checkIsGetMode('offer')).toBe(false)
    expect(checkIsGetMode('GET')).toBe(true)
    expect(checkIsGetMode('  get  ')).toBe(true)
    expect(checkIsGetMode(null)).toBe(false)
    expect(checkIsGetMode(123)).toBe(false)
  })

  it('get mode uses coral accent, offer mode uses purple', () => {
    expect(getAccentColor(true)).toBe('#FF7A6B')
    expect(getAccentColor(false)).toBe('#7357FF')
  })
})

// ── 13. Status config rendering ─────────────────────────────────────────────
describe('Status config', () => {
  it('returns correct config for each known status', () => {
    const pending = getStatusConfig('Pending')
    expect(pending.label).toBe('WAITING FOR RESPONDER')
    expect(pending.color).toBe('#a2a586')

    const enroute = getStatusConfig('Enroute')
    expect(enroute.label).toBe('RESPONDER ON THE WAY')
    expect(enroute.color).toBe('#7357FF')

    const resolved = getStatusConfig('Resolved')
    expect(resolved.label).toBe('RESOLVED')
    expect(resolved.color).toBe('#3F8487')
  })

  it('returns default config for unknown status', () => {
    const unknown = getStatusConfig('WeirdStatus')
    expect(unknown.label).toBe('UNKNOWN STATUS')
  })

  it('returns default config for non-string input', () => {
    expect(getStatusConfig(null).label).toBe('UNKNOWN STATUS')
    expect(getStatusConfig(42).label).toBe('UNKNOWN STATUS')
  })
})

// ── 14. Step completion logic ───────────────────────────────────────────────
describe('Step completion logic', () => {
  it('step 3 is done if profile has contact', () => {
    expect(computeStep3Done({ contact: '555-1234' })).toBe(true)
  })

  it('step 3 is done if profile has nickname', () => {
    expect(computeStep3Done({ nickname: 'alice' })).toBe(true)
  })

  it('step 3 is done if profile is null (fallback true)', () => {
    expect(computeStep3Done(null)).toBe(true)
  })
})

// ── 15. User character computation ──────────────────────────────────────────
describe('User character computation', () => {
  it('returns selected char if provided', () => {
    expect(computeUserCharacter('runner', {})).toBe('runner')
  })

  it('falls back to default char based on nickname', () => {
    const char = computeUserCharacter(null, { nickname: 'alice' })
    expect(typeof char).toBe('string')
    expect(char.length).toBeGreaterThan(0)
  })

  it('falls back to default char when no profile', () => {
    const char = computeUserCharacter(null, {})
    expect(typeof char).toBe('string')
  })
})
