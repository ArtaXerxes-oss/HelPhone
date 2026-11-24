import fs from 'node:fs'

const required = [
  'DATABASE_URL', 'STELLAR_SECRET_KEY', 'SESSION_SECRET', 'METRICS_BEARER_TOKEN',
  'WHITELIST_ADMIN_TOKEN', 'REDIS_URL', 'STELLAR_RPC_URL', 'STELLAR_RPC_FALLBACK_URLS',
  'TURN_URLS', 'TURN_USERNAME', 'TURN_CREDENTIAL', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY',
  'VITE_SERVER_URL', 'VITE_EVENTS_URL',
]
const example = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
const missing = required.filter((key) => !new RegExp(`^${key}=`, 'm').test(example))
if (missing.length) throw new Error(`.env.example is missing: ${missing.join(', ')}`)

const production = fs.readFileSync(new URL('../.env.production', import.meta.url), 'utf8')
for (const key of ['VITE_SERVER_URL', 'VITE_EVENTS_URL']) {
  if (!new RegExp(`^${key}=`, 'm').test(production)) throw new Error(`.env.production is missing: ${key}`)
}
console.log(`environment templates cover ${required.length} runtime variables`)
