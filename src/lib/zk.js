import { StrKey } from '@stellar/stellar-sdk'
import { getWasmMemoryPool } from './wasmMemory.js'

let _noir = null
let _backend = null
let _Noir = null
let _UltraHonkBackend = null
let _circuitArtifact = null
let _proofLock = null

const PROVER_INIT_TIMEOUT_MS = 2 * 60 * 1000
const PROOF_TIMEOUT_MS = 5 * 60 * 1000
const SERVER_HEALTH_TIMEOUT_MS = 2500
const SERVER_PROOF_TIMEOUT_MS = 10 * 60 * 1000
const PRODUCTION_ZK_PROVER_URL = 'https://helphone.onrender.com'

function normalizeBase64(input, label = 'Base64 value') {
  if (typeof input !== 'string') {
    throw new Error(`${label} must be a string.`)
  }

  let value = input.trim()
  const commaIndex = value.indexOf(',')
  if (commaIndex !== -1 && /^data:.*;base64/i.test(value.slice(0, commaIndex))) {
    value = value.slice(commaIndex + 1)
  }

  value = value
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`${label} contains invalid Base64 characters.`)
  }

  const remainder = value.length % 4
  if (remainder === 1) {
    throw new Error(`${label} has an invalid Base64 length.`)
  }
  if (remainder > 0) {
    value += '='.repeat(4 - remainder)
  }

  return value
}

export function decodeBase64Bytes(input, label) {
  const normalized = normalizeBase64(input, label)
  const binary = atob(normalized)
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}

export function decodeBase64Utf8(input, label) {
  return new TextDecoder().decode(decodeBase64Bytes(input, label))
}

async function getCircuitArtifact() {
  if (_circuitArtifact) return _circuitArtifact
  const circuitModule = await import('../../circuits/target/aegis.json')
  const circuit = circuitModule.default || circuitModule
  _circuitArtifact = {
    ...circuit,
    bytecode: normalizeBase64(circuit.bytecode, 'ZK circuit bytecode'),
    debug_symbols: circuit.debug_symbols
      ? normalizeBase64(circuit.debug_symbols, 'ZK circuit debug symbols')
      : circuit.debug_symbols,
  }
  return _circuitArtifact
}

function createBarretenbergLogger(onLog) {
  const seen = new Set()
  return message => {
    const text = String(message || '')
    let mapped = ''

    if (/Fetching bb wasm/i.test(text)) mapped = 'Loading Barretenberg WASM'
    else if (/Compiling bb wasm/i.test(text)) mapped = 'Compiling Barretenberg WASM'
    else if (/Compilation of bb wasm complete/i.test(text)) mapped = 'Barretenberg WASM ready'
    else if (/Initializing bb wasm/i.test(text)) mapped = 'Starting Barretenberg prover worker'
    else if (/Creating .* worker threads/i.test(text)) mapped = 'Starting Barretenberg worker threads'
    else if (/Falling back to one thread/i.test(text)) mapped = 'Using single-thread prover mode'

    if (mapped && !seen.has(mapped)) {
      seen.add(mapped)
      onLog(mapped)
    }
  }
}

function elapsedSeconds(startedAt) {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  return Math.round((now - startedAt) / 1000)
}

async function runWithProgress(label, task, {
  onLog,
  timeoutMs,
  firstProgressMs = 8000,
  progressEveryMs = 15000,
  progressMessage,
}) {
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
  let done = false
  let progressInterval = null
  let timeoutId = null

  const firstProgress = setTimeout(() => {
    if (done) return
    onLog(progressMessage(elapsedSeconds(startedAt)))
    progressInterval = setInterval(() => {
      if (!done) onLog(progressMessage(elapsedSeconds(startedAt)))
    }, progressEveryMs)
  }, firstProgressMs)

  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      if (!done) {
        reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds. Check your connection to crs.aztec.network and try again.`))
      }
    }, timeoutMs)
  })

  try {
    return await Promise.race([Promise.resolve().then(task), timeout])
  } finally {
    done = true
    clearTimeout(firstProgress)
    if (timeoutId) clearTimeout(timeoutId)
    if (progressInterval) clearInterval(progressInterval)
  }
}

async function resetBackend() {
  const backend = _backend
  _backend = null
  _proofLock = null
  if (backend && typeof backend.destroy === 'function') {
    try { await backend.destroy() } catch (_) {}
  }
}

function getThreadCount() {
  const available = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4
  return Math.max(1, Math.min(available, 8))
}

async function init(onLog = () => {}) {
  if (_noir && _backend) return
  if (typeof globalThis.Buffer === 'undefined') {
    const { Buffer } = await import('buffer')
    globalThis.Buffer = Buffer
  }
  if (!_Noir) {
    ;({ Noir: _Noir } = await import('@noir-lang/noir_js'))
  }
  if (!_UltraHonkBackend) {
    ;({ UltraHonkBackend: _UltraHonkBackend } = await import('@aztec/bb.js'))
  }
  const artifact = await getCircuitArtifact()
  _backend = new _UltraHonkBackend(
    artifact.bytecode,
    { threads: getThreadCount(), logger: createBarretenbergLogger(onLog) },
    { recursive: false }
  )
  _noir = new _Noir(artifact)
}

export async function warmProver(onLog = () => {}) {
  if (isProverReady()) return
  await init(onLog)
  onLog('Downloading CRS (cached after first run)')
  await _backend.instantiate()
  onLog('Prover ready')
}

export function isProverReady() {
  return _backend !== null && _noir !== null && _proofLock === null && _backend && typeof _backend.generateProof === 'function'
}

// BN254 scalar field prime
const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

// stored_lon = floor(lon * 1e7) + 1_800_000_000
// stored_lat = floor(lat * 1e7) +   900_000_000
function encodeLngNumber(lng) {
  return Math.floor(lng * 1e7) + 1_800_000_000
}

function encodeLatNumber(lat) {
  return Math.floor(lat * 1e7) + 900_000_000
}

function encodeLng(lng) {
  return String(encodeLngNumber(lng))
}

function encodeLat(lat) {
  return String(encodeLatNumber(lat))
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)))
}

export function buildLocationProofZone({ lat, lng, radiusMeters = 3000 } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('A valid location is required to build a ZK proof zone.')
  }

  const safeRadius = Number.isFinite(radiusMeters)
    ? Math.max(250, Math.min(radiusMeters, 25000))
    : 3000
  const latDelta = safeRadius / 111_320
  const lngScale = Math.max(0.2, Math.cos(lat * Math.PI / 180))
  const lngDelta = safeRadius / (111_320 * lngScale)

  const boxXMin = clampInt(encodeLngNumber(lng - lngDelta), 0, 3_600_000_000)
  const boxXMax = clampInt(encodeLngNumber(lng + lngDelta), 0, 3_600_000_000)
  const boxYMin = clampInt(encodeLatNumber(lat - latDelta), 0, 1_800_000_000)
  const boxYMax = clampInt(encodeLatNumber(lat + latDelta), 0, 1_800_000_000)

  return {
    boxXMin: String(boxXMin),
    boxXMax: String(boxXMax),
    boxYMin: String(boxYMin),
    boxYMax: String(boxYMax),
    radiusMeters: safeRadius,
    center: { lat, lng },
  }
}

function normalizeZone(zone) {
  if (!zone) {
    return {
      boxXMin: '0',
      boxXMax: '3600000000',
      boxYMin: '0',
      boxYMax: '1800000000',
      radiusMeters: null,
      center: null,
    }
  }

  for (const key of ['boxXMin', 'boxXMax', 'boxYMin', 'boxYMax']) {
    if (zone[key] === undefined || zone[key] === null || !Number.isFinite(Number(zone[key]))) {
      throw new Error(`Invalid ZK proof zone: ${key} is required.`)
    }
  }

  return {
    boxXMin: String(Math.trunc(Number(zone.boxXMin))),
    boxXMax: String(Math.trunc(Number(zone.boxXMax))),
    boxYMin: String(Math.trunc(Number(zone.boxYMin))),
    boxYMax: String(Math.trunc(Number(zone.boxYMax))),
    radiusMeters: zone.radiusMeters ?? null,
    center: zone.center ?? null,
  }
}

export function shortProofId(value) {
  const text = String(value || '')
  if (text.length <= 18) return text
  return `${text.slice(0, 10)}...${text.slice(-6)}`
}

// Decode Stellar G... address → 32 bytes → BigInt → reduce mod BN254 prime → field element
function addressToField(stellarAddress) {
  const bytes = StrKey.decodeEd25519PublicKey(stellarAddress)
  let value = 0n
  for (const b of bytes) value = (value << 8n) | BigInt(b)
  return String(value % FIELD_PRIME)
}

// Persist secret per browser so nullifier is reproducible across sessions
function getOrCreateSecret() {
  const KEY = 'hp_zk_secret'
  const stored = localStorage.getItem(KEY)
  if (stored) return stored
  const bytes = crypto.getRandomValues(new Uint8Array(31)) // 248 bits < BN254 prime
  let value = 0n
  for (const b of bytes) value = (value << 8n) | BigInt(b)
  const secret = String(value % FIELD_PRIME)
  localStorage.setItem(KEY, secret)
  return secret
}

// Build 224-byte public inputs buffer for aegis_vault.claim_aid (7 × 32-byte BE fields)
// Layout: box_x_min | box_x_max | box_y_min | box_y_max | campaign_id | recipient_address | nullifier
function buildPublicInputsBytes(boxXMin, boxXMax, boxYMin, boxYMax, campaignId, recipientField, nullifier) {
  const fields = [
    BigInt(boxXMin),
    BigInt(boxXMax),
    BigInt(boxYMin),
    BigInt(boxYMax),
    BigInt(campaignId),
    BigInt(recipientField),
    BigInt(nullifier),
  ]
  const buf = new Uint8Array(224)
  fields.forEach((f, i) => {
    const hex = f.toString(16).padStart(64, '0')
    for (let j = 0; j < 32; j++) {
      buf[i * 32 + j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16)
    }
  })
  return buf
}

function buildCampaignPrefix(publicInputsBytes) {
  return publicInputsBytes.slice(0, 160)
}

/**
 * Generate a ZK location proof through the local prover server.
 * Browser proving is available only when VITE_ZK_BROWSER_FALLBACK=true.
 *
 * @param {{ lat: number, lng: number, campaignId?: string, recipientAddress: string, zone?: object }} opts
 * @returns {{ proof: Uint8Array, publicInputsBytes: Uint8Array, nullifier: string }}
 */
export async function generateLocationProof({ lat, lng, campaignId = '1', recipientAddress, zone, onLog = () => {} }) {
  const proverUrl = resolveProverUrl()
  const allowBrowserFallback = import.meta.env.VITE_ZK_BROWSER_FALLBACK === 'true'
  const proofZone = normalizeZone(zone)

  if (proverUrl) {
    try {
      return await _requestServerProof({ lat, lng, campaignId, recipientAddress, zone: proofZone, onLog, proverUrl })
    } catch (err) {
      if (!allowBrowserFallback) {
        onLog('ZK prover server is not available')
        const hint = import.meta.env.PROD
          ? 'Set VITE_ZK_PROVER_URL to your hosted ZK prover (see README → Deploy).'
          : 'Start the app with npm run dev so the local prover server is running.'
        throw new Error(`${err.message}. ${hint}`)
      }
      onLog(`Server prover: ${err.message}. Falling back to browser because VITE_ZK_BROWSER_FALLBACK=true.`)
    }
  }

  if (_proofLock) {
    onLog('Proof already in progress — waiting for it to complete')
    return _proofLock
  }

  _proofLock = _browserProof({ lat, lng, campaignId, recipientAddress, zone: proofZone, onLog })

  try {
    return await _proofLock
  } finally {
    _proofLock = null
  }
}

function resolveProverUrl() {
  const configured = (import.meta.env.VITE_ZK_PROVER_URL || '').trim()
  const url = configured || '/zk'
  if (import.meta.env.PROD && url === '/zk') {
    return PRODUCTION_ZK_PROVER_URL
  }
  return url.replace(/\/$/, '')
}

async function _requestServerProof({ lat, lng, campaignId = '1', recipientAddress, zone, onLog = () => {}, proverUrl }) {
  onLog('Checking ZK prover server')
  await _checkServerProver(proverUrl, onLog)
  onLog('Requesting proof from ZK prover server')
  const secretId = getOrCreateSecret()
  const recipientField = addressToField(recipientAddress)

  const inputs = {
    user_x:            encodeLng(lng),
    user_y:            encodeLat(lat),
    secret_id:         secretId,
    box_x_min:         zone.boxXMin,
    box_x_max:         zone.boxXMax,
    box_y_min:         zone.boxYMin,
    box_y_max:         zone.boxYMax,
    campaign_id:       campaignId,
    recipient_address: recipientField,
  }

  const res = await fetchWithTimeout(proverEndpoint(proverUrl, '/prove'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs }),
  }, SERVER_PROOF_TIMEOUT_MS)
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}))
    throw new Error(errBody.error || `Server returned ${res.status}`)
  }
  const data = await res.json()
  if (!data.success) throw new Error(data.error || 'Server prover failed')

  const proof = hexToUint8Array(data.proof)
  const nullifier = data.nullifier
  const publicInputsBytes = buildPublicInputsBytes(
    inputs.box_x_min, inputs.box_x_max, inputs.box_y_min, inputs.box_y_max,
    campaignId, recipientField, nullifier
  )

  onLog('Proof received from server')
  return {
    proof,
    publicInputsBytes,
    publicInputsPrefix: buildCampaignPrefix(publicInputsBytes),
    nullifier,
    zone,
  }
}

async function _checkServerProver(proverUrl, onLog) {
  let res
  try {
    res = await fetchWithTimeout(proverEndpoint(proverUrl, '/health'), { cache: 'no-store' }, SERVER_HEALTH_TIMEOUT_MS)
  } catch {
    throw new Error('ZK prover server is unreachable')
  }

  if (!res.ok) {
    throw new Error(`ZK prover health check returned ${res.status}`)
  }

  const data = await res.json().catch(() => ({}))
  if (data.ready) {
    onLog('ZK prover is ready')
  } else {
    onLog('ZK prover is warming up; first run downloads CRS once')
  }
}

function proverEndpoint(proverUrl, path) {
  if (proverUrl.endsWith('/zk')) return `${proverUrl}${path}`
  return `${proverUrl}/zk${path}`
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`)
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}

function hexToUint8Array(hex) {
  if (typeof hex !== 'string') throw new Error('expected hex string')
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

async function _browserProof({ lat, lng, campaignId = '1', recipientAddress, zone, onLog = () => {} }) {
  onLog('Loading ZK circuit artifacts')
  await init(onLog)

  onLog('Validating Stellar wallet address')
  if (!recipientAddress || !StrKey.isValidEd25519PublicKey(recipientAddress)) {
    throw new Error('Connect a valid Stellar wallet before generating the proof.')
  }

  onLog('Preparing private location inputs')
  const secretId = getOrCreateSecret()
  const recipientField = addressToField(recipientAddress)

  const inputs = {
    user_x:            encodeLng(lng),
    user_y:            encodeLat(lat),
    secret_id:         secretId,
    box_x_min:         zone.boxXMin,
    box_x_max:         zone.boxXMax,
    box_y_min:         zone.boxYMin,
    box_y_max:         zone.boxYMax,
    campaign_id:       campaignId,
    recipient_address: recipientField,
  }

  onLog('Executing Noir circuit witness')
  // WASM memory pooling: recycle buffers across runs to avoid re-allocating WASM memory
  const memPool = getWasmMemoryPool()
  let witnessBuf = null
  let proofScratch = null
  try { witnessBuf = memPool.allocate(256 * 1024); proofScratch = memPool.allocate(2 * 1024 * 1024) } catch {}
  const { witness, returnValue } = await _noir.execute(inputs)
  if (witnessBuf) memPool.release(witnessBuf)
  // keep proofScratch until after proof generation

  onLog('Preparing Barretenberg prover')
  try {
    await runWithProgress('Barretenberg prover setup', () => _backend.instantiate(), {
      onLog,
      timeoutMs: PROVER_INIT_TIMEOUT_MS,
      firstProgressMs: 7000,
      progressEveryMs: 12000,
      progressMessage: seconds => `Still preparing prover (${seconds}s). First run downloads and caches CRS data.`,
    })
  } catch (err) {
    await resetBackend()
    throw err
  }
  onLog('Barretenberg prover ready')

  onLog('Generating UltraHonk proof')
  let proofResult
  try {
    proofResult = await runWithProgress('UltraHonk proof generation', () => _backend.generateProof(witness), {
      onLog,
      timeoutMs: PROOF_TIMEOUT_MS,
      firstProgressMs: 10000,
      progressEveryMs: 20000,
      progressMessage: seconds => `Still generating UltraHonk proof (${seconds}s). Keep this tab open.`,
    })
  } catch (err) {
    if (proofScratch) try { memPool.release(proofScratch) } catch {}
    await resetBackend()
    throw err
  }
  const { proof, publicInputs } = proofResult
  if (proofScratch) try { memPool.release(proofScratch) } catch {}
  onLog('UltraHonk proof generated')

  // returnValue is the nullifier (field element)
  const nullifier = typeof returnValue === 'string'
    ? returnValue
    : String(returnValue)

  const publicInputsBytes = buildPublicInputsBytes(
    zone.boxXMin, zone.boxXMax, zone.boxYMin, zone.boxYMax,
    campaignId, recipientField, nullifier
  )

  onLog('Packing public inputs for Stellar')

  return {
    proof,
    publicInputsBytes,
    publicInputsPrefix: buildCampaignPrefix(publicInputsBytes),
    nullifier,
    publicInputs,
    zone,
  }
}
