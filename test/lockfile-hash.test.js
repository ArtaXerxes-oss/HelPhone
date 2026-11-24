import { describe, expect, it, vi } from 'vitest'
import { cargoEntries, npmEntries, validateLockfileChecksums, verifyEntries } from '../scripts/verify-lockfile-hashes.js'

describe('lockfile hash verifier #583', () => {
  const npm = [{ ecosystem: 'npm', name: 'safe', version: '1.0.0', checksum: 'sha512-YWJjZA==' }]
  const cargo = [{ ecosystem: 'cargo', name: 'safe', version: '1.0.0', checksum: 'a'.repeat(64) }]
  it('parses npm and Cargo locks', () => {
    expect(npmEntries({ packages: { 'node_modules/safe': { version: '1.0.0', integrity: npm[0].checksum } } })).toEqual(npm)
    expect(cargoEntries('[[package]]\nname = "safe"\nversion = "1.0.0"\nchecksum = "' + 'a'.repeat(64) + '"\n')).toEqual(cargo)
  })
  it('detects malformed and registry-divergent hashes', async () => {
    expect(validateLockfileChecksums([{ ...npm[0], checksum: 'sha1-bad' }], cargo)).toHaveLength(1)
    const fetchImpl = vi.fn(async (url) => ({ ok: true, json: async () => url.includes('npmjs') ? { dist: { integrity: 'sha512-different==' } } : { version: { checksum: 'a'.repeat(64) } } }))
    expect(await verifyEntries([...npm, ...cargo], { fetchImpl, concurrency: 2 })).toEqual([expect.objectContaining({ ecosystem: 'npm', reason: 'checksum mismatch' })])
  })
})
