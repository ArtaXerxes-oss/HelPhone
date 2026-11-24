import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../docs/adr/', import.meta.url);
const resultsRoot = new URL('../spikes/results/', root);
const start = '<!-- ADR-EVIDENCE-START -->';
const end = '<!-- ADR-EVIDENCE-END -->';
const linked = new Set();
const rows = [];
const failures = [];

for (const file of readdirSync(root).filter((name) => /^ADR-\d{3}-.*\.md$/.test(name) && !name.includes('-000-')).sort()) {
  const body = readFileSync(new URL(file, root), 'utf8');
  const citations = [...body.matchAll(/\.\.\/spikes\/results\/([\w-]+\.json)/g)].map((match) => match[1]);
  const checks = [...body.matchAll(/\*\*Evidence check:\*\* `([\w-]+\.json)#(\/[^`=]+) = (-?\d+(?:\.\d+)?)`/g)];
  const unique = new Set(citations);
  for (const resultFile of unique) {
    linked.add(resultFile);
    if (!readdirSync(resultsRoot).includes(resultFile)) failures.push(`${file}: missing ${resultFile}`);
    if (!checks.some((check) => check[1] === resultFile)) failures.push(`${file}: ${resultFile} has no checked numeric citation`);
  }
  for (const check of checks) {
    const [, resultFile, pointer, expected] = check;
    if (!unique.has(resultFile)) {
      failures.push(`${file}: checked ${resultFile} without citing it`);
      continue;
    }
    const data = JSON.parse(readFileSync(new URL(resultFile, resultsRoot), 'utf8'));
    const actual = pointer.slice(1).split('/').reduce((value, key) => value?.[key], data);
    if (typeof actual !== 'number' || actual !== Number(expected)) failures.push(`${file}: stale ${resultFile}#${pointer} (document says ${expected}; result has ${actual})`);
  }
  const status = unique.size ? `Checked (${unique.size} result${unique.size === 1 ? '' : 's'})`
    : body.includes('**Evidence status:** Unmeasured.') ? 'Unmeasured' : 'No raw result cited';
  rows.push(`| [${file.split('-').slice(0, 2).join('-')}](${file}) | ${status} |`);
}

for (const file of readdirSync(resultsRoot).filter((name) => name.endsWith('.json'))) {
  if (!linked.has(file)) failures.push(`${file}: no ADR cites this spike result`);
}

const indexPath = new URL('README.md', root);
const current = readFileSync(indexPath, 'utf8');
const table = `${start}\n| ADR | Evidence status |\n|---|---|\n${rows.join('\n')}\n${end}`;
const next = current.includes(start) && current.includes(end)
  ? current.replace(new RegExp(`${start}[\\s\\S]*?${end}`), table)
  : current.replace(/\r?\n---\r?\n\r?\n## Done-definition/, `\n\n## Evidence status\n\n${table}\n\n---\n\n## Done-definition`);
if (next === current && !current.includes(start)) failures.push('docs/adr/README.md: index insertion point not found');
if (process.argv.includes('--write') && !failures.length) writeFileSync(indexPath, next);
if (!process.argv.includes('--write') && next !== current) failures.push('ADR evidence index is stale; run node scripts/check-adr-evidence.mjs --write');
if (failures.length) {
  process.stderr.write(failures.join('\n') + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`ADR evidence checked ${linked.size} result files.\n`);
}
