#!/usr/bin/env node

import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

export function flattenLockfileDeps(lockfile, flat = new Map()) {
  if (!lockfile || typeof lockfile !== 'object') return flat;
  if (lockfile.packages && typeof lockfile.packages === 'object') {
    for (const [pkgPath, info] of Object.entries(lockfile.packages)) {
      if (!pkgPath) continue;
      const name = info.name || pkgPath.replace(/^.*node_modules\//, '');
      if (!name || !info.version) continue;
      if (!flat.has(name)) {
        flat.set(name, {
          name,
          version: info.version,
          resolved: info.resolved || '',
          integrity: info.integrity || '',
        });
      }
    }
  }
  if (lockfile.dependencies && typeof lockfile.dependencies === 'object') {
    flattenNpmDeps(lockfile.dependencies, flat);
  }
  return flat;
}

function generateNpmBOM(targetRoot = rootDir) {
  console.log('📦 Generating npm SBOM...');
  try {
    const npmList = execSync('npm list --json', {
      cwd: targetRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(npmList);
  } catch (error) {
    console.warn('⚠️ npm list failed, falling back to package-lock.json:', error.message);
    const lockPath = path.join(targetRoot, 'package-lock.json');
    if (fs.existsSync(lockPath)) {
      return JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    }
    return { dependencies: {} };
  }
}

export function flattenNpmDeps(deps, flat = new Map()) {
  if (!deps) return flat;

  for (const [name, info] of Object.entries(deps)) {
    if (!flat.has(name) && info?.version) {
      flat.set(name, {
        name,
        version: info.version,
        resolved: info.resolved,
        integrity: info.integrity || '',
      });
    }
    if (info?.dependencies) {
      flattenNpmDeps(info.dependencies, flat);
    }
  }

  return flat;
}

function generateCargoBOM(targetRoot = rootDir) {
  console.log('📦 Generating Cargo (Rust) SBOM...');
  const cargoDeps = new Map();

  const cargoTomlFiles = [
    path.join(targetRoot, 'Cargo.toml'),
    path.join(targetRoot, 'contracts/aegis_vault/Cargo.toml'),
    path.join(targetRoot, 'contracts/maintainer_vault/Cargo.toml'),
    path.join(targetRoot, 'contract/Cargo.toml'),
  ];

  for (const cargoPath of cargoTomlFiles) {
    if (!fs.existsSync(cargoPath)) continue;

    try {
      const dir = path.dirname(cargoPath);
      const output = execSync('cargo tree --depth 1 -e normal', {
        cwd: dir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const lines = output.split('\n');
      for (const line of lines) {
        const match = line.match(/^([a-zA-Z0-9_-]+)\s+v(\S+)/);
        if (match) {
          const [, name, version] = match;
          cargoDeps.set(`${name}@${version}`, {
            name,
            version,
            ecosystem: 'cargo',
          });
        }
      }
    } catch (error) {
      console.warn(`⚠️ cargo tree failed for ${cargoPath}:`, error.message);
    }
  }

  return cargoDeps;
}

export function buildCycloneDXBOM(npmDeps, cargoDeps = new Map()) {
  const timestamp = new Date().toISOString();

  const components = [];

  for (const [, dep] of npmDeps) {
    components.push({
      type: 'library',
      name: dep.name,
      version: dep.version,
      purl: `pkg:npm/${dep.name}@${dep.version}`,
      scope: 'required',
      ...(dep.integrity ? { hashes: [{ alg: 'SHA-512', content: dep.integrity }] } : {}),
    });
  }

  for (const [, dep] of cargoDeps) {
    components.push({
      type: 'library',
      name: dep.name,
      version: dep.version,
      purl: `pkg:cargo/${dep.name}@${dep.version}`,
      scope: 'required',
    });
  }

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.4',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp,
      tools: [
        {
          vendor: 'HelPhone',
          name: 'generate-sbom',
          version: '1.0.0',
        },
      ],
      component: {
        type: 'application',
        name: 'helphone',
        version: '1.0.0',
      },
    },
    components: components.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function generateSBOM({ root = rootDir, outFile = path.join(rootDir, 'sbom.json'), offline = false } = {}) {
  let npmDeps;
  if (offline) {
    const lockPath = path.join(root, 'package-lock.json');
    const lock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf-8')) : {};
    npmDeps = flattenLockfileDeps(lock);
  } else {
    const npmTree = generateNpmBOM(root);
    npmDeps = flattenLockfileDeps(npmTree);
  }
  const cargoDeps = offline ? new Map() : generateCargoBOM(root);
  const bom = buildCycloneDXBOM(npmDeps, cargoDeps);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(bom, null, 2));
  return bom;
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outFile = outIdx !== -1 ? path.resolve(rootDir, args[outIdx + 1]) : path.join(rootDir, 'sbom.json');
  const offline = args.includes('--offline');

  console.log('🔍 Generating Software Bill of Materials (SBOM)...\n');
  const bom = generateSBOM({ root: rootDir, outFile, offline });

  if (!bom.components || bom.components.length === 0) {
    console.error('❌ SBOM generation produced 0 components; failing release.');
    process.exit(1);
  }

  console.log(`\n✅ SBOM generated: ${outFile}`);
  console.log(`📊 Total components: ${bom.components.length}`);
  console.log(`📅 Generated at: ${bom.metadata.timestamp}`);
  process.exit(0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}
