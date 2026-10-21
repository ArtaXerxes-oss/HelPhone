#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const NPM_REGISTRY = 'https://registry.npmjs.org'
const CRATES_REGISTRY = 'https://crates.io/api/v1'

export function npmEntries(lock) {
  return Object.entries(lock.packages ?? {}).flatMap(([path, value]) => {
    if (!path || !value?.version || !value?.integrity || value.link) return []
    const name = path.slice(path.lastIndexOf('node_modules/') + 13)
    return [{ ecosystem: 'npm', name, version: value.version, checksum: value.integrity }]
  })
}

export function cargoEntries(text) {
  return text.split(/\n(?=\[\[package\]\])/).flatMap((block) => {
    const name = block.match(/^name = "([^"]+)"/m)?.[1]
    const version = block.match(/^version = "([^"]+)"/m)?.[1]
    const checksum = block.match(/^checksum = "([a-f0-9]+)"/m)?.[1]
    return name && version && checksum ? [{ ecosystem: 'cargo', name, version, checksum }] : []
  })
}

async function registryChecksum(entry, fetchImpl) {
  if (entry.ecosystem === 'npm') {
    const name = entry.name.startsWith('@') ? `@${entry.name.slice(1).replace('/', '%2f')}` : encodeURIComponent(entry.name)
    const response = await fetchImpl(`${NPM_REGISTRY}/${name}/${encodeURIComponent(entry.version)}`, { headers: { accept: 'application/vnd.npm.install-v1+json' } })
    if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${entry.name}@${entry.version}`)
    return (await response.json()).dist?.integrity
  }
  const response = await fetchImpl(`${CRATES_REGISTRY}/crates/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`, { headers: { 'user-agent': 'helphone-lockfile-verifier/1.0' } })
  if (!response.ok) throw new Error(`crates.io returned ${response.status} for ${entry.name}@${entry.version}`)
  return (await response.json()).version?.checksum
}

export async function verifyEntries(entries, { fetchImpl = fetch, concurrency = 12 } = {}) {
  const failures = []
  let next = 0
  async function worker() {
    while (next < entries.length) {
      const entry = entries[next++]
      try {
        const published = await registryChecksum(entry, fetchImpl)
        if (!published || published !== entry.checksum) failures.push({ ...entry, published: published ?? 'missing', reason: 'checksum mismatch' })
      } catch (error) {
        failures.push({ ...entry, reason: error.message })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker))
  return failures
}

export function validateLockfileChecksums(npm, cargo) {
  const invalid = []
  for (const entry of npm) if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.checksum)) invalid.push({ ...entry, reason: 'npm integrity is not SHA-512' })
  for (const entry of cargo) if (!/^[a-f0-9]{64}$/.test(entry.checksum)) invalid.push({ ...entry, reason: 'Cargo checksum is not SHA-256' })
  return invalid
}

export async function main(args = process.argv.slice(2)) {
  const offline = args.includes('--offline')
  const [lock, cargoText] = await Promise.all([readFile('package-lock.json', 'utf8').then(JSON.parse), readFile('Cargo.lock', 'utf8')])
  const npm = npmEntries(lock)
  const cargo = cargoEntries(cargoText)
  const failures = validateLockfileChecksums(npm, cargo)

  // ISP-093: Verify exact build-tag pinning for @sqlite.org/sqlite-wasm
  const sqliteEntry = lock.packages?.['node_modules/@sqlite.org/sqlite-wasm']
  if (sqliteEntry && sqliteEntry.version && /^[\^~]/.test(sqliteEntry.version)) {
    failures.push({
      ecosystem: 'npm',
      name: '@sqlite.org/sqlite-wasm',
      version: sqliteEntry.version,
      reason: 'build-tag bypass: version must be pinned exactly without ^ or ~',
    })
  }

  // ISP-093: Cross-check server/package-lock.json for drift if present
  try {
    const serverLock = JSON.parse(await readFile('server/package-lock.json', 'utf8'))
    const rootPackages = lock.packages || {}
    const serverPackages = serverLock.packages || {}
    for (const [pathKey, sVal] of Object.entries(serverPackages)) {
      if (!pathKey.startsWith('node_modules/') || !sVal?.version) continue
      const rVal = rootPackages[pathKey]
      if (rVal && (rVal.version !== sVal.version || (rVal.integrity && sVal.integrity && rVal.integrity !== sVal.integrity))) {
        failures.push({
          ecosystem: 'npm',
          name: pathKey.replace('node_modules/', ''),
          version: `${rVal.version} vs ${sVal.version}`,
          reason: 'cross-lockfile drift between root and server',
        })
      }
    }
  } catch {
    // server/package-lock.json optional / not present
  }

  if (!offline) failures.push(...await verifyEntries([...npm, ...cargo]))
  if (failures.length) {
    console.error('SECURITY: lockfile integrity verification failed')
    for (const item of failures.slice(0, 50)) console.error(`- ${item.ecosystem}:${item.name}@${item.version}: ${item.reason}`)
    if (failures.length > 50) console.error(`...and ${failures.length - 50} more`)
    process.exitCode = 1
  } else console.log(`Verified ${npm.length} npm SHA-512 and ${cargo.length} Cargo SHA-256 checksums${offline ? ' structurally (offline)' : ' against official registries'}.`)
  return { npm: npm.length, cargo: cargo.length, failures }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
