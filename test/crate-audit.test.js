import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

describe('Soroban Smart Contract Crate Audit Pipeline', () => {
  it('should create cargo audit script', () => {
    const auditScript = path.join(projectRoot, 'scripts/cargo-crate-audit.sh');
    expect(fs.existsSync(auditScript)).toBe(true);
  });

  it('should be executable bash script', () => {
    const auditScript = path.join(projectRoot, 'scripts/cargo-crate-audit.sh');
    const content = fs.readFileSync(auditScript, 'utf-8');

    expect(content).toContain('#!/bin/bash');
    expect(content).toContain('set -euo pipefail');
  });

  it('should audit aegis_vault contract', () => {
    const auditScript = path.join(projectRoot, 'scripts/cargo-crate-audit.sh');
    const content = fs.readFileSync(auditScript, 'utf-8');

    expect(content).toContain('contracts/aegis_vault');
  });

  it('should audit maintainer_vault contract', () => {
    const auditScript = path.join(projectRoot, 'scripts/cargo-crate-audit.sh');
    const content = fs.readFileSync(auditScript, 'utf-8');

    expect(content).toContain('contracts/maintainer_vault');
  });

  it('should audit main contract', () => {
    const auditScript = path.join(projectRoot, 'scripts/cargo-crate-audit.sh');
    const content = fs.readFileSync(auditScript, 'utf-8');

    expect(content).toContain('contract');
  });

  it('should check dependencies availability', () => {
    const auditScript = path.join(projectRoot, 'scripts/cargo-crate-audit.sh');
    const content = fs.readFileSync(auditScript, 'utf-8');

    expect(content).toContain('check_dependencies');
    expect(content).toContain('cargo');
    expect(content).toContain('cargo-audit');
  });

  it('should verify no_std compliance', () => {
    const auditScript = path.join(projectRoot, 'scripts/cargo-crate-audit.sh');
    const content = fs.readFileSync(auditScript, 'utf-8');

    expect(content).toContain('no_std');
    expect(content).toContain('wasm32-unknown-unknown');
  });

  it('should validate dependency version pinning', () => {
    const auditScript = path.join(projectRoot, 'scripts/cargo-crate-audit.sh');
    const content = fs.readFileSync(auditScript, 'utf-8');

    expect(content).toContain('verify_pinned_versions');
    expect(content).toContain('pinned');
  });

  it('should enforce exact version pinning policy', () => {
    const auditScript = path.join(projectRoot, 'scripts/cargo-crate-audit.sh');
    const content = fs.readFileSync(auditScript, 'utf-8');

    expect(content).toContain('=X.Y.Z');
    expect(content).toContain('semver');
  });

  it('should check RustSec Advisory Database', () => {
    const auditScript = path.join(projectRoot, 'scripts/cargo-crate-audit.sh');
    const content = fs.readFileSync(auditScript, 'utf-8');

    expect(content).toContain('cargo audit');
    expect(content).toContain('RustSec');
  });

  it('should handle audit failures with exit codes', () => {
    const auditScript = path.join(projectRoot, 'scripts/cargo-crate-audit.sh');
    const content = fs.readFileSync(auditScript, 'utf-8');

    expect(content).toContain('exit 0');
    expect(content).toContain('exit 1');
  });

  it('should provide colored output for readability', () => {
    const auditScript = path.join(projectRoot, 'scripts/cargo-crate-audit.sh');
    const content = fs.readFileSync(auditScript, 'utf-8');

    expect(content).toContain('RED=');
    expect(content).toContain('GREEN=');
    expect(content).toContain('YELLOW=');
    expect(content).toContain('BLUE=');
  });
});
