#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lockfiles = ['package-lock.json', 'server/package-lock.json'];

export async function lockedPackages(projectRoot) {
  const entries = [];
  for (const lockfile of lockfiles) {
    const lock = JSON.parse(await readFile(path.join(projectRoot, lockfile), 'utf8'));
    for (const [packagePath, pkg] of Object.entries(lock.packages ?? {})) {
      if (!packagePath || pkg.link || (!pkg.integrity && !pkg.resolved)) continue;
      if (!pkg.integrity || !pkg.resolved || !/^https:\/\//.test(pkg.resolved)) {
        throw new Error(`${lockfile}:${packagePath} has no verifiable archive and integrity`);
      }
      const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(pkg.integrity);
      if (!match || Buffer.from(match[1], 'base64').length !== 64) {
        throw new Error(`${lockfile}:${packagePath} has invalid SHA-512 integrity`);
      }
      entries.push({ lockfile, packagePath, resolved: pkg.resolved, integrity: pkg.integrity });
    }
  }
  return entries.sort((a, b) => `${a.lockfile}:${a.packagePath}`.localeCompare(`${b.lockfile}:${b.packagePath}`));
}

export function archiveName(integrity) {
  return Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex') + '.tgz';
}

export function verifyArchive(bytes, integrity) {
  const actual = createHash('sha512').update(bytes).digest('base64');
  if (`sha512-${actual}` !== integrity) throw new Error(`Archive integrity mismatch: expected ${integrity}`);
}

export async function vendorDependencies({ projectRoot = root, verify = false, fetchImpl = fetch } = {}) {
  const vendorDir = path.join(projectRoot, '.vendor-cache');
  const archiveDir = path.join(vendorDir, 'tarballs');
  const manifestPath = path.join(vendorDir, 'VENDOR_MANIFEST.json');
  const entries = await lockedPackages(projectRoot);
  const manifest = { version: 1, entries: entries.map(({ lockfile, packagePath, integrity }) => ({ lockfile, packagePath, integrity, archive: archiveName(integrity) })) };

  if (verify) {
    const saved = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (JSON.stringify(saved) !== JSON.stringify(manifest)) throw new Error('Vendor manifest differs from lockfiles');
  } else {
    await mkdir(archiveDir, { recursive: true });
  }

  const unique = [...new Map(entries.map((entry) => [entry.integrity, entry])).values()];
  let next = 0;
  async function worker() {
    while (next < unique.length) {
      const entry = unique[next++];
      const archivePath = path.join(archiveDir, archiveName(entry.integrity));
      let bytes;
      if (existsSync(archivePath)) {
        bytes = await readFile(archivePath);
      } else if (!verify) {
        const response = await fetchImpl(entry.resolved);
        if (!response.ok) throw new Error(`Download failed (${response.status}): ${entry.resolved}`);
        bytes = Buffer.from(await response.arrayBuffer());
      } else {
        throw new Error(`Missing vendored archive: ${archivePath}`);
      }
      verifyArchive(bytes, entry.integrity);
      if (!existsSync(archivePath)) await writeFile(archivePath, bytes);
    }
  }
  await Promise.all(Array.from({ length: Math.min(12, unique.length) }, worker));
  if (!verify) await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { packages: entries.length, archives: unique.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  vendorDependencies({ verify: process.argv.includes('--verify') })
    .then(({ packages, archives }) => console.log(`Verified ${packages} lockfile entries in ${archives} vendored archives`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
