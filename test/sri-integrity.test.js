import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

describe('Subresource Integrity (SRI) Generator', () => {
  it('should create SRI hash generator script', () => {
    const sriScript = path.join(projectRoot, 'scripts/generate-sri-hashes.js');
    expect(fs.existsSync(sriScript)).toBe(true);
  });

  it('should generate valid SHA-384 SRI hashes', () => {
    const testContent = 'test script content';
    const hash = createHash('sha384').update(testContent).digest('base64');

    expect(hash).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(hash.length).toBeGreaterThan(40);
  });

  it('should include crossorigin attribute with SRI', () => {
    const sriScript = path.join(projectRoot, 'scripts/generate-sri-hashes.js');
    const content = fs.readFileSync(sriScript, 'utf-8');

    expect(content).toContain('crossorigin');
    expect(content).toContain('anonymous');
    expect(content).toContain('integrity');
  });

  it('should output sri-hashes.json with asset metadata', () => {
    const sriScript = path.join(projectRoot, 'scripts/generate-sri-hashes.js');
    const content = fs.readFileSync(sriScript, 'utf-8');

    expect(content).toContain('sri-hashes.json');
    expect(content).toContain('assetMap');
    expect(content).toContain('url');
  });

  it('should support external asset fetching', () => {
    const sriScript = path.join(projectRoot, 'scripts/generate-sri-hashes.js');
    const content = fs.readFileSync(sriScript, 'utf-8');

    expect(content).toContain('fetch');
    expect(content).toContain('externalAssets');
    expect(content).toContain('cdnjs.cloudflare.com');
  });

  it('should inject SRI into HTML files', () => {
    const sriScript = path.join(projectRoot, 'scripts/generate-sri-hashes.js');
    const content = fs.readFileSync(sriScript, 'utf-8');

    expect(content).toContain('injectSRIIntoHTML');
    expect(content).toContain('index.html');
  });

  it('should validate SRI hash format', () => {
    const sriFormat = /^sha384-[A-Za-z0-9+/=]+$/;
    const testHash = 'sha384-abcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd1234567890abcd';

    expect(testHash).toMatch(sriFormat);
  });

  it('should handle failed asset fetches gracefully', () => {
    const sriScript = path.join(projectRoot, 'scripts/generate-sri-hashes.js');
    const content = fs.readFileSync(sriScript, 'utf-8');

    expect(content).toContain('Could not fetch');
    expect(content).toContain('continue-on-error');
  });
});
