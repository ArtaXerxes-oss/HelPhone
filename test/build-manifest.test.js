import { describe, it, expect } from 'vitest'

import { validateManifestEntries } from '../src/lib/buildManifestIntegrity.js'

describe('build manifest integrity', () => {
  it('accepts a manifest whose assets exist on disk', () => {
    const manifest = {
      'index.html': {
        file: 'assets/index.js',
        src: 'src/main.jsx',
      },
      'src/main.jsx': {
        file: 'assets/main.js',
      },
    }

    const result = validateManifestEntries(manifest, {
      '/tmp/helphone-dist': {
        'assets/index.js': true,
        'assets/main.js': true,
      },
    })

    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('flags missing files before the app serves stale preload links', () => {
    const manifest = {
      'index.html': {
        file: 'assets/index.js',
        src: 'src/main.jsx',
      },
      'src/main.jsx': {
        file: 'assets/does-not-exist.js',
      },
    }

    const result = validateManifestEntries(manifest, {
      '/tmp/helphone-dist': {
        'assets/index.js': true,
      },
    })

    expect(result.ok).toBe(false)
    expect(result.missing).toContain('assets/does-not-exist.js')
  })
})
