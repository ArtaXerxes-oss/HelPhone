import { describe, it, expect } from 'vitest'

import { resolveAllowedOrigins, isAllowedOrigin } from '../server/index.js'

describe('ZK prover CORS defaults', () => {
  it('includes local Vite and localhost origins when no env override is set', () => {
    const allowed = resolveAllowedOrigins({})

    expect(allowed).toContain('http://localhost:3000')
    expect(allowed).toContain('http://127.0.0.1:3000')
    expect(allowed).toContain('http://localhost:5173')
  })

  it('allows localhost origins and rejects untrusted domains', () => {
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:3001')).toBe(true)
    expect(isAllowedOrigin('https://evil.example')).toBe(false)
  })
})
