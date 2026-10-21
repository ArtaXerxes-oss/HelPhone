import { existsSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

function normalizeAssetPath(value) {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/\\/g, '/').replace(/^\/+/, '')
  return cleaned || null
}

function collectManifestEntries(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return []
  }

  const entries = []

  function walk(value) {
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }

    if (!value || typeof value !== 'object') return

    if (typeof value.file === 'string') {
      const normalized = normalizeAssetPath(value.file)
      if (normalized) entries.push(normalized)
    }

    if (Array.isArray(value.css)) {
      value.css.forEach(cssFile => {
        const normalized = normalizeAssetPath(cssFile)
        if (normalized) entries.push(normalized)
      })
    }

    Object.values(value).forEach(walk)
  }

  walk(manifest)
  return [...new Set(entries)]
}

export function validateManifestEntries(manifest, fileMap = null) {
  const entries = collectManifestEntries(manifest)
  const missing = []

  if (fileMap) {
    const available = new Set()
    Object.values(fileMap).forEach(setMap => {
      if (!setMap || typeof setMap !== 'object') return
      Object.keys(setMap).forEach(file => available.add(normalizeAssetPath(file)))
    })

    entries.forEach(file => {
      if (!available.has(file)) missing.push(file)
    })

    return {
      ok: missing.length === 0,
      missing,
      checked: entries.length,
    }
  }

  entries.forEach(file => {
    const isMissing = !existsSync(join(process.cwd(), 'dist', file))
    if (isMissing) missing.push(file)
  })

  return {
    ok: missing.length === 0,
    missing,
    checked: entries.length,
  }
}

export async function loadManifest(manifestPath) {
  const fs = await import('node:fs/promises')
  const raw = await fs.readFile(manifestPath, 'utf8')
  return JSON.parse(raw)
}
