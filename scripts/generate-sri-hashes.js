#!/usr/bin/env node

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

function computeSHA384(content) {
  return createHash('sha384').update(content).digest('base64');
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

async function generateSRIHashes() {
  const assetMap = {};

  const externalAssets = [
    {
      name: 'react',
      url: 'https://cdnjs.cloudflare.com/ajax/libs/react/19.0.0/react.production.min.js'
    },
    {
      name: 'react-dom',
      url: 'https://cdnjs.cloudflare.com/ajax/libs/react-dom/19.0.0/react-dom.production.min.js'
    },
    {
      name: 'mapbox-gl',
      url: 'https://api.mapbox.com/mapbox-gl/v3.25.0/mapbox-gl.min.js'
    },
    {
      name: 'mapbox-gl-css',
      url: 'https://api.mapbox.com/mapbox-gl/v3.25.0/mapbox-gl.css'
    }
  ];

  console.log('Generating SRI hashes for external assets...\n');

  for (const asset of externalAssets) {
    const content = await fetchExternalAsset(asset.url);
    if (!content) {
      console.warn(`Skipping ${asset.name} (could not fetch)`);
      continue;
    }

    const hash = computeSHA384(content);
    assetMap[asset.name] = {
      url: asset.url,
      integrity: `sha384-${hash}`
    };

    console.log(`✓ ${asset.name}`);
    console.log(`  URL: ${asset.url}`);
    console.log(`  Integrity: sha384-${hash}\n`);
  }

  const outputFile = path.join(rootDir, 'sri-hashes.json');
  fs.writeFileSync(outputFile, JSON.stringify(assetMap, null, 2));
  console.log(`✅ SRI hashes saved to ${outputFile}`);

  return assetMap;
}

async function injectSRIIntoHTML(sriHashes) {
  const htmlFile = path.join(rootDir, 'index.html');
  if (!fs.existsSync(htmlFile)) {
    console.warn(`⚠️ index.html not found at ${htmlFile}`);
    return;
  }

  let html = fs.readFileSync(htmlFile, 'utf-8');
  let modified = false;

  for (const [name, { integrity }] of Object.entries(sriHashes)) {
    if (name.includes('react')) {
      const scriptRegex = new RegExp(
        `(<script[^>]*src="[^"]*react[^"]*"[^>]*)>`,
        'gi'
      );
      html = html.replace(scriptRegex, (match) => {
        if (!match.includes('integrity=')) {
          modified = true;
          return match.replace('>', ` integrity="${integrity}" crossorigin="anonymous">`);
        }
        return match;
      });
    }
  }

  if (modified) {
    fs.writeFileSync(htmlFile, html);
    console.log(`✅ SRI attributes injected into index.html`);
  } else {
    console.log('ℹ️  No modifications needed for index.html');
  }
}

async function main() {
  const sriHashes = await generateSRIHashes();
  await injectSRIIntoHTML(sriHashes);
  console.log('\n✅ SRI generation complete');
  process.exit(0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
