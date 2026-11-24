import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { archiveName, vendorDependencies } from '../scripts/security/vendor_deps.js';

test('vendors both lockfiles with real hashes and rejects tampered archives', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'helphone-vendor-'));
  const bytes = Buffer.from('synthetic npm archive');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const pkg = { version: '1.0.0', resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', integrity };
  try {
    await mkdir(path.join(projectRoot, 'server'));
    for (const lockfile of ['package-lock.json', 'server/package-lock.json']) {
      await writeFile(path.join(projectRoot, lockfile), JSON.stringify({ packages: { '': {}, 'node_modules/example': pkg } }));
    }
    let downloads = 0;
    await vendorDependencies({ projectRoot, fetchImpl: async () => { downloads++; return new Response(bytes); } });
    assert.equal(downloads, 1);
    await vendorDependencies({ projectRoot, verify: true, fetchImpl: () => { throw new Error('verify must be offline'); } });

    const manifestPath = path.join(projectRoot, '.vendor-cache/VENDOR_MANIFEST.json');
    const manifestText = await readFile(manifestPath, 'utf8');
    await vendorDependencies({ projectRoot, fetchImpl: () => { throw new Error('cache must be reused'); } });
    assert.equal(await readFile(manifestPath, 'utf8'), manifestText);
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.entries.length, 2);
    assert.equal(manifest.entries[0].integrity, integrity);

    const archive = path.join(projectRoot, '.vendor-cache/tarballs', archiveName(integrity));
    await writeFile(archive, 'tampered');
    await assert.rejects(vendorDependencies({ projectRoot, verify: true }), /Archive integrity mismatch/);
    await writeFile(archive, bytes);

    await writeFile(path.join(projectRoot, 'server/package-lock.json'), JSON.stringify({ packages: { '': {}, 'node_modules/example': { ...pkg, integrity: undefined } } }));
    await assert.rejects(vendorDependencies({ projectRoot }), /no verifiable archive and integrity/);

    await writeFile(path.join(projectRoot, 'server/package-lock.json'), JSON.stringify({ packages: { '': {}, 'node_modules/example': { ...pkg, integrity: `sha512-${createHash('sha512').update('different').digest('base64')}` } } }));
    await assert.rejects(vendorDependencies({ projectRoot, verify: true }), /manifest differs from lockfiles/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
