import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
describe('cross-origin isolation headers (#581)', () => {
  it('sets matching development and production headers', () => {
    const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
    const server = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8')
    for (const header of ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy']) {
      expect(vite).toContain(header)
      expect(server).toContain(header)
    }
  })
  it('keeps Mapbox compatible with credentialless COEP', () => {
    const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
    expect(vite).toContain('"credentialless"')
  })
})
