import { describe, it, expect } from 'vitest'
import { assertValidContractId } from '../src/lib/contract'

// ---------------------------------------------------------------------------
// Issues #329 / #330 — DEFAULT_CONTRACT_ID / CONTRACT_ID hardening
//
// A malformed contract ID used to propagate silently into the Contract()
// constructor and only fail later as an opaque RPC/simulation error.
// assertValidContractId() fails fast with a clear message instead.
// ---------------------------------------------------------------------------

const VALID_CONTRACT_ID = 'CDP5XZ7UYCGSQBYRDYM2OEAUQJULBZPULSQXK7LGNAJTRXRG3VHZLSHY'

describe('assertValidContractId', () => {
  it('returns a well-formed contract ID unchanged', () => {
    expect(assertValidContractId(VALID_CONTRACT_ID, 'TEST_ID')).toBe(VALID_CONTRACT_ID)
  })

  it('accepts the deployed default contract ID (DEFAULT_CONTRACT_ID)', () => {
    expect(VALID_CONTRACT_ID).toHaveLength(56)
    expect(() => assertValidContractId(VALID_CONTRACT_ID, 'DEFAULT_CONTRACT_ID')).not.toThrow()
  })

  it('throws on a wallet G-address instead of a contract C-address', () => {
    const gAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3'
    expect(() => assertValidContractId(gAddress, 'CONTRACT_ID')).toThrow(/not a valid Stellar contract ID/)
  })

  it('throws on a truncated contract ID', () => {
    expect(() => assertValidContractId(VALID_CONTRACT_ID.slice(0, 40), 'CONTRACT_ID')).toThrow()
  })

  it('throws on a contract ID with invalid base32 characters', () => {
    const invalid = 'C' + '1'.repeat(55) // '1' and '0' are not valid base32 digits
    expect(() => assertValidContractId(invalid, 'CONTRACT_ID')).toThrow()
  })

  it('throws on a same-length, same-charset typo that fails the CRC16 checksum', () => {
    // Last character flipped: still 56 chars, still [A-Z2-7], but the strkey checksum no longer matches.
    const typo = VALID_CONTRACT_ID.slice(0, -1) + (VALID_CONTRACT_ID.endsWith('Y') ? 'X' : 'Y')
    expect(() => assertValidContractId(typo, 'CONTRACT_ID')).toThrow()
  })

  it('throws on non-string input (null, undefined, number)', () => {
    expect(() => assertValidContractId(null, 'CONTRACT_ID')).toThrow()
    expect(() => assertValidContractId(undefined, 'CONTRACT_ID')).toThrow()
    expect(() => assertValidContractId(12345, 'CONTRACT_ID')).toThrow()
  })

  it('throws on an empty string', () => {
    expect(() => assertValidContractId('', 'CONTRACT_ID')).toThrow()
  })

  it('includes the provided label in the error message', () => {
    expect(() => assertValidContractId('bad', 'CONTRACT_ID')).toThrow(/CONTRACT_ID/)
  })
})
