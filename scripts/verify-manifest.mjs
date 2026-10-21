import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { validateManifestEntries } from '../src/lib/buildManifestIntegrity.js'

const projectRoot = process.cwd()
const manifestPath = join(projectRoot, 'dist', '.vite', 'manifest.json')

if (!existsSync(manifestPath)) {
  console.error('Manifest missing: dist/.vite/manifest.json. Run npm run build first.')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const report = validateManifestEntries(manifest)

if (!report.ok) {
  console.error('Build manifest references missing assets:')
  for (const missing of report.missing) {
    console.error(` - ${missing}`)
  }
  process.exit(1)
}

console.log(`Manifest check passed: ${report.checked} asset entries verified.`)
