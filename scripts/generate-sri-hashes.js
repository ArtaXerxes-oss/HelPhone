#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const EXTERNAL_ASSETS = [
  {
    name: 'react',
    url: 'https://cdnjs.cloudflare.com/ajax/libs/react/19.0.0/react.production.min.js',
  },
  {
    name: 'react-dom',
    url: 'https://cdnjs.cloudflare.com/ajax/libs/react-dom/19.0.0/react-dom.production.min.js',
  },
  {
    name: 'mapbox-gl',
    url: 'https://api.mapbox.com/mapbox-gl/v3.25.0/mapbox-gl.min.js',
  },
  {
    name: 'mapbox-gl-css',
    url: 'https://api.mapbox.com/mapbox-gl/v3.25.0/mapbox-gl.css',
  },
];

export function computeSHA384(content) {
  return createHash('sha384').update(content).digest('base64');
}

function walkAssetFiles(dir, baseDir = dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkAssetFiles(full, baseDir));
    } else if (/\.(js|mjs|css|wasm)$/i.test(entry.name)) {
      results.push(path.relative(baseDir, full).replace(/\\/g, '/'));
    }
  }
  return results.sort();
}

export function generateLocalSRIHashes(distDir) {
  const localAssets = {};
  for (const rel of walkAssetFiles(distDir)) {
    const content = fs.readFileSync(path.join(distDir, rel));
    localAssets[rel] = {
      path: rel,
      integrity: `sha384-${computeSHA384(content)}`,
      bytes: content.length,
    };
  }
  return localAssets;
}

export function injectLocalSRIIntoHTML(htmlPath, localAssets) {
  if (!fs.existsSync(htmlPath)) return false;
  let html = fs.readFileSync(htmlPath, 'utf-8');
  let modified = false;

  for (const [rel, { integrity }] of Object.entries(localAssets)) {
    const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tagRegex = new RegExp(
      `(<(?:script|link)[^>]+(?:src|href)=["'][^"']*${escaped}["'][^>]*)(>)`,
      'gi',
    );
    html = html.replace(tagRegex, (match, prefix, close) => {
      if (/\bintegrity=/.test(prefix)) {
        const updated = prefix.replace(/\bintegrity=["'][^"']*["']/, `integrity="${integrity}"`);
        if (updated !== prefix) modified = true;
        return `${updated}${close}`;
      }
      modified = true;
      const crossorigin = /\bcrossorigin=/.test(prefix) ? '' : ' crossorigin="anonymous"';
      return `${prefix} integrity="${integrity}"${crossorigin}${close}`;
    });
  }

  if (modified) {
    fs.writeFileSync(htmlPath, html);
  }
  return modified;
}

export function verifySRIHashes({ distDir, sriPath, htmlPath } = {}) {
  const problems = [];
  if (!fs.existsSync(sriPath)) {
    return { ok: false, checked: 0, problems: [`SRI manifest missing: ${sriPath}`] };
  }

  const manifest = JSON.parse(fs.readFileSync(sriPath, 'utf-8'));
  const localAssets = manifest.localAssets || {};
  const entries = Object.entries(localAssets);
  if (entries.length === 0) {
    problems.push('SRI manifest contains 0 localAssets');
  }

  for (const [rel, meta] of entries) {
    const filePath = path.join(distDir, rel);
    if (!fs.existsSync(filePath)) {
      problems.push(`missing asset: ${rel}`);
      continue;
    }
    const actual = `sha384-${computeSHA384(fs.readFileSync(filePath))}`;
    if (actual !== meta.integrity) {
      problems.push(`SRI mismatch for ${rel}: expected ${meta.integrity}, got ${actual}`);
    }
  }

  if (htmlPath && fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf-8');
    for (const [rel, meta] of entries) {
      const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const refMatch = html.match(new RegExp(`<(?:script|link)[^>]+(?:src|href)=["'][^"']*${escaped}["'][^>]*>`, 'i'));
      if (refMatch) {
        const integMatch = refMatch[0].match(/\bintegrity=["']([^"']+)["']/i);
        if (!integMatch) {
          problems.push(`missing integrity attribute in ${path.basename(htmlPath)} for ${rel}`);
        } else if (integMatch[1] !== meta.integrity) {
          problems.push(`HTML integrity mismatch for ${rel}: expected ${meta.integrity}, got ${integMatch[1]}`);
        }
      }
    }
  }

  return { ok: problems.length === 0, checked: entries.length, problems };
}

async function fetchExternalAsset(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    console.warn(`⚠️ Could not fetch ${url}: ${error.message}`);
    return null;
  }
}

async function generateSRIHashes({ distDir, outFile, offline = false } = {}) {
  const externalAssets = {};

  if (!offline) {
    console.log('Generating SRI hashes for external assets...\n');
    for (const asset of EXTERNAL_ASSETS) {
      const content = await fetchExternalAsset(asset.url);
      if (!content) {
        console.warn(`Skipping ${asset.name} (could not fetch)`);
        continue;
      }
      const hash = computeSHA384(content);
      externalAssets[asset.name] = {
        url: asset.url,
        integrity: `sha384-${hash}`,
      };
    }
  }

  const localAssets = fs.existsSync(distDir) ? generateLocalSRIHashes(distDir) : {};
  const distHtml = path.join(distDir, 'index.html');
  injectLocalSRIIntoHTML(distHtml, localAssets);

  const payload = {
    generatedAt: new Date().toISOString(),
    algorithm: 'sha384',
    localAssets,
    externalAssets,
  };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log(`✅ SRI hashes saved to ${outFile} (${Object.keys(localAssets).length} local assets)`);
  return payload;
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes('--offline');
  const verify = args.includes('--verify');
  const distIdx = args.indexOf('--dist');
  const outIdx = args.indexOf('--out');

  const distDir = distIdx !== -1 ? path.resolve(rootDir, args[distIdx + 1]) : path.join(rootDir, 'dist');
  const outFile = outIdx !== -1 ? path.resolve(rootDir, args[outIdx + 1]) : path.join(rootDir, 'sri-hashes.json');

  if (verify) {
    const result = verifySRIHashes({
      distDir,
      sriPath: outFile,
      htmlPath: path.join(distDir, 'index.html'),
    });
    if (!result.ok) {
      for (const p of result.problems) console.error(`❌ ${p}`);
      process.exit(1);
    }
    console.log(`✅ SRI verification passed (${result.checked} local assets verified)`);
    process.exit(0);
  }

  await generateSRIHashes({ distDir, outFile, offline });
  console.log('\n✅ SRI generation complete');
  process.exit(0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
