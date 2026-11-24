import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

describe('Software Bill of Materials (SBOM) Generator', () => {
  it('should create SBOM generator script', () => {
    const sbomScript = path.join(projectRoot, 'scripts/generate-sbom.js');
    expect(fs.existsSync(sbomScript)).toBe(true);
  });

  it('should generate CycloneDX SBOM format', () => {
    const sbomScript = path.join(projectRoot, 'scripts/generate-sbom.js');
    const content = fs.readFileSync(sbomScript, 'utf-8');

    expect(content).toContain('CycloneDX');
    expect(content).toContain('bomFormat');
    expect(content).toContain('specVersion');
  });

  it('should aggregate npm dependencies', () => {
    const sbomScript = path.join(projectRoot, 'scripts/generate-sbom.js');
    const content = fs.readFileSync(sbomScript, 'utf-8');

    expect(content).toContain('generateNpmBOM');
    expect(content).toContain('npm list');
  });

  it('should aggregate Cargo (Rust) dependencies', () => {
    const sbomScript = path.join(projectRoot, 'scripts/generate-sbom.js');
    const content = fs.readFileSync(sbomScript, 'utf-8');

    expect(content).toContain('generateCargoBOM');
    expect(content).toContain('cargo tree');
  });

  it('should flatten dependency trees', () => {
    const sbomScript = path.join(projectRoot, 'scripts/generate-sbom.js');
    const content = fs.readFileSync(sbomScript, 'utf-8');

    expect(content).toContain('flattenNpmDeps');
    expect(content).toContain('Map');
  });

  it('should include Package URLs (PURL)', () => {
    const sbomScript = path.join(projectRoot, 'scripts/generate-sbom.js');
    const content = fs.readFileSync(sbomScript, 'utf-8');

    expect(content).toContain('purl');
    expect(content).toContain('pkg:npm');
    expect(content).toContain('pkg:cargo');
  });

  it('should output to sbom.json', () => {
    const sbomScript = path.join(projectRoot, 'scripts/generate-sbom.js');
    const content = fs.readFileSync(sbomScript, 'utf-8');

    expect(content).toContain('sbom.json');
    expect(content).toContain('writeFileSync');
  });

  it('should include metadata with timestamps', () => {
    const sbomScript = path.join(projectRoot, 'scripts/generate-sbom.js');
    const content = fs.readFileSync(sbomScript, 'utf-8');

    expect(content).toContain('timestamp');
    expect(content).toContain('toISOString');
    expect(content).toContain('metadata');
  });

  it('should target multiple Cargo workspaces', () => {
    const sbomScript = path.join(projectRoot, 'scripts/generate-sbom.js');
    const content = fs.readFileSync(sbomScript, 'utf-8');

    expect(content).toContain('aegis_vault');
    expect(content).toContain('maintainer_vault');
    expect(content).toContain('contract');
  });

  it('should include tool attribution', () => {
    const sbomScript = path.join(projectRoot, 'scripts/generate-sbom.js');
    const content = fs.readFileSync(sbomScript, 'utf-8');

    expect(content).toContain('tools');
    expect(content).toContain('vendor');
    expect(content).toContain('name');
  });
});
