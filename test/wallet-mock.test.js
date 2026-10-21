import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Manual mock for @creit-tech/stellar-wallets-kit ─────────────────────────
// Provides controllable fake implementations of signTransaction, getAddress,
// and the event system so Help.jsx and contract.js can be tested without a
// real wallet extension.

const listeners = {}

const StellarWalletsKit = {
  getAddress: vi.fn().mockResolvedValue({ address: '' }),
  authModal: vi.fn().mockResolvedValue({ address: '' }),
  signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: '' }),
  on: vi.fn((event, cb) => {
    if (!listeners[event]) listeners[event] = []
    listeners[event].push(cb)
    return () => {
      listeners[event] = listeners[event].filter((fn) => fn !== cb)
    }
  }),
  disconnect: vi.fn(),
  _emit(event, payload) {
    ;(listeners[event] || []).forEach((cb) => cb({ payload }))
  },
  _reset() {
    for (const key of Object.keys(listeners)) delete listeners[key]
    vi.clearAllMocks()
  },
}

const KitEventType = {
  STATE_UPDATED: 'STATE_UPDATED',
  DISCONNECT: 'DISCONNECT',
}

describe('StellarWalletsKit mock', () => {
  beforeEach(() => {
    StellarWalletsKit._reset()
  })

  it('getAddress returns empty by default', async () => {
    const result = await StellarWalletsKit.getAddress()
    expect(result).toEqual({ address: '' })
  })

  it('authModal returns configured address', async () => {
    StellarWalletsKit.authModal.mockResolvedValue({ address: 'GAAAAAA' })
    const result = await StellarWalletsKit.authModal()
    expect(result).toEqual({ address: 'GAAAAAA' })
  })

  it('signTransaction returns signed XDR', async () => {
    StellarWalletsKit.signTransaction.mockResolvedValue({ signedTxXdr: 'base64xdr' })
    const result = await StellarWalletsKit.signTransaction('tx-xdr', {})
    expect(result).toEqual({ signedTxXdr: 'base64xdr' })
  })

  it('on registers and fires event listeners', () => {
    const cb = vi.fn()
    StellarWalletsKit.on(KitEventType.STATE_UPDATED, cb)
    StellarWalletsKit._emit(KitEventType.STATE_UPDATED, { address: 'GTEST' })
    expect(cb).toHaveBeenCalledWith({ payload: { address: 'GTEST' } })
  })

  it('on returns an unsubscribe function', () => {
    const cb = vi.fn()
    const unsub = StellarWalletsKit.on(KitEventType.STATE_UPDATED, cb)
    unsub()
    StellarWalletsKit._emit(KitEventType.STATE_UPDATED, { address: 'GTEST' })
    expect(cb).not.toHaveBeenCalled()
  })

  it('disconnect is callable', () => {
    StellarWalletsKit.disconnect()
    expect(StellarWalletsKit.disconnect).toHaveBeenCalled()
  })

  it('_reset clears all listeners and mocks', () => {
    const cb = vi.fn()
    StellarWalletsKit.on(KitEventType.STATE_UPDATED, cb)
    StellarWalletsKit.authModal.mockResolvedValue({ address: 'GRESET' })

    StellarWalletsKit._reset()

    StellarWalletsKit._emit(KitEventType.STATE_UPDATED, { address: 'GTEST' })
    expect(cb).not.toHaveBeenCalled()
  })
})
