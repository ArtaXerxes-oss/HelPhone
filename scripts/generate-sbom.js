#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

function generateNpmBOM() {
  console.log('📦 Generating npm SBOM...');
  try {
    const npmList = execSync('npm list --json', {
      cwd: rootDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return JSON.parse(npmList);
  } catch (error) {
    console.warn('⚠️ npm list failed:', error.message);
    return { dependencies: {} };
  }
}

function flattenNpmDeps(deps, flat = new Map()) {
  if (!deps) return flat;

  for (const [name, info] of Object.entries(deps)) {
    if (!flat.has(name)) {
      flat.set(name, {
        name,
        version: info.version,
        resolved: info.resolved,
        integrity: info.integrity || ''
      });
    }
    if (info.dependencies) {
      flattenNpmDeps(info.dependencies, flat);
    }
  }

  return flat;
}

function generateCargoBOM() {
  console.log('📦 Generating Cargo (Rust) SBOM...');
  const cargoDeps = new Map();

  const cargoTomlFiles = [
    path.join(rootDir, 'Cargo.toml'),
    path.join(rootDir, 'contracts/aegis_vault/Cargo.toml'),
    path.join(rootDir, 'contracts/maintainer_vault/Cargo.toml'),
    path.join(rootDir, 'contract/Cargo.toml')
  ];

  for (const cargoPath of cargoTomlFiles) {
    if (!fs.existsSync(cargoPath)) continue;

    try {
      const dir = path.dirname(cargoPath);
      const output = execSync('cargo tree --depth 1 -e normal', {
        cwd: dir,
        encoding: 'utf-8'
      });

      const lines = output.split('\n');
      for (const line of lines) {
        const match = line.match(/^([a-zA-Z0-9_-]+)\s+v(\S+)/);
        if (match) {
          const [, name, version] = match;
          cargoDeps.set(`${name}@${version}`, {
            name,
            version,
            ecosystem: 'cargo'
          });
        }
      }
    } catch (error) {
      console.warn(`⚠️ cargo tree failed for ${cargoPath}:`, error.message);
    }
  }

  return cargoDeps;
}

function buildCycloneDXBOM(npmDeps, cargoDeps) {
  const timestamp = new Date().toISOString();

  const components = [];

  for (const [, dep] of npmDeps) {
    components.push({
      type: 'library',
      name: dep.name,
      version: dep.version,
      purl: `pkg:npm/${dep.name}@${dep.version}`,
      scope: 'required'
    });
  }

  for (const [, dep] of cargoDeps) {
    components.push({
      type: 'library',
      name: dep.name,
      version: dep.version,
      purl: `pkg:cargo/${dep.name}@${dep.version}`,
      scope: 'required'
    });
  }

  const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.4',
    serialNumber: `urn:uuid:${crypto.randomUUID ? crypto.randomUUID() : 'unknown'}`,
    version: 1,
    metadata: {
      timestamp,
      tools: [
        {
          vendor: 'HelPhone',
          name: 'generate-sbom',
          version: '1.0.0'
        }
      ],
      component: {
        type: 'application',
        name: 'helphone',
        version: '1.0.0'
      }
    },
    components: components.sort((a, b) => a.name.localeCompare(b.name))
  };

  return bom;
}

function main() {
  console.log('🔍 Generating Software Bill of Materials (SBOM)...\n');

  const npmTree = generateNpmBOM();
  const npmDeps = flattenNpmDeps(npmTree.dependencies);
  console.log(`✓ Found ${npmDeps.size} npm dependencies`);

  const cargoDeps = generateCargoBOM();
  console.log(`✓ Found ${cargoDeps.size} Cargo dependencies`);

  const bom = buildCycloneDXBOM(npmDeps, cargoDeps);

  const outputFile = path.join(rootDir, 'sbom.json');
  fs.writeFileSync(outputFile, JSON.stringify(bom, null, 2));

  console.log(`\n✅ SBOM generated: ${outputFile}`);
  console.log(`📊 Total components: ${bom.components.length}`);
  console.log(`📅 Generated at: ${bom.metadata.timestamp}`);

  process.exit(0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
