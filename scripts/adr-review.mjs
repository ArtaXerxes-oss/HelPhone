import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const root = new URL('../docs/adr/', import.meta.url);
const indexPath = new URL('README.md', root);
const start = '<!-- ADR-INDEX-START -->';
const end = '<!-- ADR-INDEX-END -->';
const files = readdirSync(root).filter((file) => /^ADR-\d{3}-.*\.md$/.test(file) && !file.includes('-000-')).sort();
const records = files.map((file) => {
  const body = readFileSync(new URL(file, root), 'utf8');
  const title = body.match(/^#\s+ADR-(\d{3})\s*[—:–-]\s*(.+)$/m);
  const status = body.match(/^\s*(?:-\s*)?\*\*Status:\*\*\s*(.+)$/m)
    ?? body.match(/^\|\s*Status\s*\|\s*(.+?)\s*\|$/m);
  const spike = body.match(/^\s*(?:-\s*)?\*\*(?:ISP \/ Spike|Spike):\*\*\s*(.+)$/m);
  if (!title || !status) throw new Error(`${file}: missing ADR title or status`);
  const expiry = status[1].match(/Deferred\s*\(expires\s+(\d{4})-Q([1-4]),\s*owner:\s*([^)]*)\)/);
  return {
    file, number: title[1], title: title[2].trim(), status: status[1].trim(),
    spike: spike?.[1].trim() ?? '—', body,
    expiry: expiry ? { year: Number(expiry[1]), quarter: Number(expiry[2]), owner: expiry[3].trim() } : null,
    uncheckedReview: /- \[ \] CODEOWNERS review obtained/.test(body),
  };
});

function expiryDate({ year, quarter }) {
  return new Date(Date.UTC(year, quarter * 3, 0, 23, 59, 59));
}

const mode = process.argv[2] ?? '--check';
if (mode === '--due-json') {
  const now = process.env.ADR_REVIEW_NOW ? new Date(process.env.ADR_REVIEW_NOW) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('ADR_REVIEW_NOW must be a valid ISO date');
  process.stdout.write(JSON.stringify(records.filter((record) => {
    if (!record.expiry) return false;
    const until = expiryDate(record.expiry).getTime() - now.getTime();
    return until >= 0 && until <= 30 * 24 * 60 * 60 * 1000;
  }).map(({ file, title, expiry }) => ({ file, title, expiry: `${expiry.year}-Q${expiry.quarter}`, owner: expiry.owner }))) + '\n');
} else if (mode === '--report') {
  const quarter = Math.floor(new Date().getUTCMonth() / 3) + 1;
  process.stdout.write(`# ADR review report — ${new Date().getUTCFullYear()}-Q${quarter}\n\n`);
  process.stdout.write(`Unchecked CODEOWNERS review: ${records.filter((r) => r.uncheckedReview).length}\n\n`);
  for (const record of records.filter((r) => r.uncheckedReview)) process.stdout.write(`- ${record.file}: ${record.title}\n`);
  process.stdout.write('\nDeferred decisions:\n');
  for (const record of records.filter((r) => r.expiry)) process.stdout.write(`- ${record.file}: ${record.status}\n`);
} else if (mode === '--write' || mode === '--check') {
  const current = readFileSync(indexPath, 'utf8');
  const table = [
    '| ADR | Title | Status | ISP / Spike |',
    '|---|---|---|---|',
    ...records.map((r) => `| [ADR-${r.number}](${r.file}) | ${r.title.replaceAll('|', '\\|')} | ${r.status.replaceAll('|', '\\|')} | ${r.spike.replaceAll('|', '\\|')} |`),
  ].join('\n');
  const section = `${start}\n${table}\n${end}`;
  const next = current.includes(start) && current.includes(end)
    ? current.replace(new RegExp(`${start}[\\s\\S]*?${end}`), section)
    : current.replace(/\| ADR \| Title \| Status \| ISP \/ Spike \|[\s\S]*?(?=\r?\n---\r?\n)/, section);
  if (next === current && !current.includes(start)) throw new Error('ADR index section not found');
  if (mode === '--write') writeFileSync(indexPath, next);
  else if (next !== current) throw new Error('ADR index is stale; run node scripts/adr-review.mjs --write');
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
