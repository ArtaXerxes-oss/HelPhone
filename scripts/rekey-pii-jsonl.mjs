import fs from 'node:fs'
import { redactObject } from '../server/lib/redact.js'

const [input, output] = process.argv.slice(2)
if (!input || !output) throw new Error('usage: node scripts/rekey-pii-jsonl.mjs input.jsonl output.jsonl')
const rows = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean)
const converted = rows.map((line, index) => {
  const row = JSON.parse(line)
  if (JSON.stringify(row).includes('"hmac:')) throw new Error(`row ${index + 1} has no plaintext source and cannot be re-keyed`)
  return JSON.stringify(redactObject(row))
})
fs.writeFileSync(output, converted.join('\n') + '\n', { flag: 'wx', mode: 0o600 })
console.log(`re-keyed ${converted.length} rows`)
