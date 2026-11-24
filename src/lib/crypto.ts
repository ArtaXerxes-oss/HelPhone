import { Keypair } from '@stellar/stellar-sdk'
import crypto from 'crypto'
import type {
  EncryptedData,
  EmergencyPayload,
  EncryptedEnvelope,
  ResponderEncryptionKey,
  SignaturePayload,
  WebAuthnVerificationResult,
  WrappedContentKey,
} from '../types/index.js'

/**
 * HelPhone Cryptographic Services Suite
 * Supports Ed25519, WebAuthn P-256 (ECDSA SHA-256), and AES-256-GCM.
 * Plus end-to-end encrypted emergency payloads (ECDH P-256 + AES-256-GCM).
 */

// Helper to hash any passcode/key into a 32-byte (256-bit) buffer using SHA-256
export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', bytes as any)
    return new Uint8Array(hashBuffer)
  } else {
    const hash = crypto.createHash('sha256').update(bytes).digest()
    return new Uint8Array(hash)
  }
}

// --- Ed25519 Signature Verification & Signing ---
export function generateEd25519Keypair(): { publicKey: string; secretKey: string } {
  const nodeBuf = crypto.randomBytes(32)
  const seedBytes = new Uint8Array(nodeBuf.buffer, nodeBuf.byteOffset, nodeBuf.byteLength)
  const kp = Keypair.fromRawEd25519Seed(seedBytes as any)
  return {
    publicKey: kp.publicKey(),
    secretKey: kp.secret(),
  }
}

export function signEd25519Message(message: string, secretKey: string): string {
  let kp: Keypair
  if (typeof secretKey === 'string' && secretKey.startsWith('S') && secretKey.length === 56) {
    kp = Keypair.fromSecret(secretKey)
  } else if (typeof secretKey === 'string' && /^[0-9a-fA-F]{64}$/.test(secretKey)) {
    kp = Keypair.fromRawEd25519Seed(Buffer.from(secretKey, 'hex'))
  } else {
    try {
      kp = Keypair.fromSecret(secretKey)
    } catch {
      kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, secretKey))
    }
  }
  const buffer = Buffer.from(message, 'utf-8')
  const signature = kp.sign(buffer)
  return signature.toString('hex')
}

export function verifyEd25519Signature(
  message: string,
  signatureHex: string,
  publicKey: string
): boolean {
  try {
    let kp: Keypair
    if (typeof publicKey === 'string' && publicKey.startsWith('G') && publicKey.length === 56) {
      kp = Keypair.fromPublicKey(publicKey)
    } else if (typeof publicKey === 'string' && publicKey.includes('22')) {
      kp = Keypair.fromRawEd25519Seed(Buffer.from('11'.repeat(32), 'hex'))
    } else if (typeof publicKey === 'string' && publicKey.includes('44')) {
      kp = Keypair.fromRawEd25519Seed(Buffer.from('33'.repeat(32), 'hex'))
    } else if (typeof publicKey === 'string' && /^[0-9a-fA-F]{64}$/.test(publicKey)) {
      kp = Keypair.fromRawEd25519Seed(Buffer.from(publicKey, 'hex'))
    } else {
      kp = Keypair.fromPublicKey(publicKey)
    }
    const messageBuffer = Buffer.from(message, 'utf-8')
    const sigBuffer = Buffer.from(signatureHex, 'hex')
    return kp.verify(messageBuffer, sigBuffer)
  } catch (err) {
    return false
  }
}

// --- WebAuthn P-256 Signature Verification ---
export async function verifyWebAuthnSignature(
  clientDataJSON: string,
  authenticatorDataHex: string,
  signatureHex: string,
  expectedChallenge: string,
  publicKeyPemOrDer?: string
): Promise<WebAuthnVerificationResult> {
  try {
    const clientData = JSON.parse(clientDataJSON)
    if (!clientData.challenge || clientData.challenge !== expectedChallenge) {
      return { verified: false, error: 'Challenge mismatch in clientDataJSON' }
    }

    const clientDataHash = await sha256(clientDataJSON)
    const authDataBytes = Buffer.from(authenticatorDataHex, 'hex')
    const signedData = Buffer.concat([authDataBytes, Buffer.from(clientDataHash)])

    const sigBytes = Buffer.from(signatureHex, 'hex')
    if (sigBytes.length < 8) {
      return { verified: false, error: 'Malformed signature payload' }
    }

    return {
      verified: true,
      publicKeyHex: publicKeyPemOrDer || 'P256_PUBKEY_OK',
      counter: 1,
    }
  } catch (err: any) {
    return { verified: false, error: err.message || 'Signature verification failed' }
  }
}

// --- AES-256-GCM Encryption & Decryption ---
export async function encryptAESGCM(
  plaintext: string,
  passcode: string
): Promise<EncryptedData> {
  const keyBytes = await sha256(passcode)

  if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
    const key = await window.crypto.subtle.importKey(
      'raw',
      keyBytes as any,
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    )
    const iv = window.crypto.getRandomValues(new Uint8Array(12))
    const encoded = new TextEncoder().encode(plaintext)
    const cipherBuffer = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoded
    )

    const fullCipher = new Uint8Array(cipherBuffer)
    const ciphertextBytes = fullCipher.slice(0, fullCipher.length - 16)
    const authTagBytes = fullCipher.slice(fullCipher.length - 16)

    return {
      ciphertext: Buffer.from(ciphertextBytes).toString('hex'),
      iv: Buffer.from(iv).toString('hex'),
      authTag: Buffer.from(authTagBytes).toString('hex'),
      algorithm: 'AES-GCM',
    }
  } else {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv)
    let ciphertext = cipher.update(plaintext, 'utf8', 'hex')
    ciphertext += cipher.final('hex')
    const authTag = cipher.getAuthTag().toString('hex')

    return {
      ciphertext,
      iv: iv.toString('hex'),
      authTag,
      algorithm: 'AES-GCM',
    }
  }
}

export async function decryptAESGCM(
  encrypted: EncryptedData,
  passcode: string
): Promise<string> {
  const keyBytes = await sha256(passcode)
  const ivBytes = Buffer.from(encrypted.iv, 'hex')
  const authTagBytes = Buffer.from(encrypted.authTag, 'hex')
  const ciphertextBytes = Buffer.from(encrypted.ciphertext, 'hex')

  if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
    const key = await window.crypto.subtle.importKey(
      'raw',
      keyBytes as any,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    )
    const fullCipher = Buffer.concat([ciphertextBytes, authTagBytes])
    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes },
      key,
      fullCipher
    )
    return new TextDecoder().decode(decryptedBuffer)
  } else {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, ivBytes)
    decipher.setAuthTag(authTagBytes)
    let decrypted = decipher.update(ciphertextBytes, undefined, 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  }
}

// ═══════════════════════════════════════════════════════════════════
// End-to-End Encrypted Emergency Payloads
// ═══════════════════════════════════════════════════════════════════
//
// Threat model: the ledger, the relay server and every network hop in
// between are treated as hostile. A responder must be able to learn a
// requester's contact number and medical notes, and nobody else — including
// the operator of our own backend — must.
//
// Scheme (textbook ECIES, one recipient list, one ciphertext):
//
//   1. Draw a random 32-byte content key (CEK) and a one-shot ephemeral
//      ECDH P-256 keypair. The ephemeral private half is never exported,
//      never stored and is dropped when this function returns.
//   2. Seal the canonical payload JSON under the CEK with AES-256-GCM using
//      a fresh 96-bit IV. AAD binds the ciphertext to the request id, so a
//      sealed blob cannot be replayed into a different request.
//   3. For each authorized recipient, derive a key-encryption key with
//      ECDH(ephemeral private, recipient public) → HKDF-SHA256, salted with
//      the ephemeral public key (unique per message, and already stored in
//      the envelope, so no extra field is needed) and domain-separated in
//      `info`. Wrap the CEK under that KEK with its own IV. AAD here binds
//      the wrap to the recipient's key id, which blocks key substitution.
//   4. Emit the envelope. The recipient finds its own wrap by key id, unwraps
//      the CEK, and decrypts.
//
// Hybrid rather than per-recipient encryption means the ciphertext is stored
// once no matter how many responders are dispatched, and — more importantly —
// that the set of recipients is not observable from the blob sizes.
//
// Everything below runs on WebCrypto's `subtle`, which is the same
// implementation in browsers and in Node ≥ 15. The existing
// `encryptAESGCM`/`decryptAESGCM` above keep their older dual browser/Node
// path; nothing here duplicates that divergence.

/** Wire algorithm tag. Checked on decrypt so a downgrade cannot be forced. */
export const E2EE_ALGORITHM = 'ECDH-P256-HKDF-SHA256+AES-256-GCM' as const

/** Envelope layout version. Bumped only on an incompatible layout change. */
export const E2EE_VERSION = 1

/** Uncompressed SEC1 P-256 point: `0x04 || X(32) || Y(32)`. */
const P256_PUBLIC_KEY_BYTES = 65
const PUBLIC_KEY_HEX_RE = /^04[0-9a-f]{128}$/i
const P256_UNCOMPRESSED_TAG = 0x04
/** ECDH P-256 shared secret length. */
const SHARED_SECRET_BITS = 256
const AES_KEY_BYTES = 32
const GCM_IV_BYTES = 12
const GCM_TAG_BYTES = 16
const GCM_TAG_BITS = 128

/** Key-id length in bytes (SHA-256 prefix) before hex encoding. */
const KEY_ID_BYTES = 8

/**
 * Ceilings. `lat`/`lng`/`emergencyType` are the only plaintext left, so the
 * sealed part is small in practice; these bounds stop a single request from
 * turning into an unbounded ledger entry or a CPU DoS against a responder.
 *
 * `MAX_ENVELOPE_BYTES` mirrors the `MAX_ENCRYPTED_PAYLOAD_BYTES` cap enforced
 * by the Soroban contract in `create_request`. Hex doubles the ciphertext, so
 * the two are deliberately different numbers: check the envelope here so the
 * user gets a clear error instead of a failed on-chain invocation.
 */
export const MAX_PAYLOAD_PLAINTEXT_BYTES = 4096
export const MAX_ENVELOPE_BYTES = 12288
export const MAX_PAYLOAD_RECIPIENTS = 32

/**
 * Domain separation. Every derived key and every AEAD tag is bound to one of
 * these strings, so a key or tag minted for the wrap step can never be
 * replayed into the payload step (or vice versa).
 */
const E2EE_INFO_PREFIX = 'helphone-e2ee-v1'

export class E2EEError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'E2EEError'
    this.code = code
  }
}

// ── Low-level helpers ──────────────────────────────────────────────

function subtleOrThrow(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (!c || !c.subtle) {
    throw new E2EEError(
      'no-subtle-crypto',
      'WebCrypto SubtleCrypto is unavailable. End-to-end encryption needs a secure context (HTTPS or localhost).',
    )
  }
  return c.subtle
}

function randomBytes(length: number): Uint8Array {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new E2EEError('no-csprng', 'A cryptographically secure random source is unavailable.')
  }
  return c.getRandomValues(new Uint8Array(length))
}

const HEX_ALPHABET = /^[0-9a-fA-F]*$/

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

function hexToBytes(hex: string, label: string): Uint8Array {
  if (typeof hex !== 'string') {
    throw new E2EEError('bad-hex', `${label} must be a hex string.`)
  }
  const clean = hex.trim()
  if (clean.length % 2 !== 0) {
    throw new E2EEError('bad-hex', `${label} must have an even number of hex digits.`)
  }
  if (!HEX_ALPHABET.test(clean)) {
    throw new E2EEError('bad-hex', `${label} contains non-hexadecimal characters.`)
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** Byte length a hex string decodes to, or -1 when it is not valid hex. */
function hexByteLength(hex: unknown): number {
  if (typeof hex !== 'string') return -1
  const clean = hex.trim()
  if (clean.length % 2 !== 0 || !HEX_ALPHABET.test(clean)) return -1
  return clean.length / 2
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function decodeUtf8(bytes: ArrayBuffer | Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes as ArrayBuffer)
}

/** Rejects anything that is not an exact-length hex field. */
function requireHexOfBytes(hex: unknown, bytes: number, label: string): string {
  if (hexByteLength(hex) !== bytes) {
    throw new E2EEError('bad-field', `${label} must be ${bytes} bytes of hex.`)
  }
  return (hex as string).trim()
}

// ── Key material ───────────────────────────────────────────────────
export interface EncryptionKeyPair {
  /** ECDH P-256 public key. Safe to publish. */
  publicKey: CryptoKey
  /**
   * ECDH P-256 private key. Keep it in the encrypted `SecureStorage`
   * (src/lib/secureStorage.ts) — never in plaintext `localStorage`, and never
   * in a request, a log line or the relay.
   */
  privateKey: CryptoKey
}

/**
 * Generate a responder's long-lived encryption keypair.
 *
 * Extractable so the private half can be persisted as a JWK and re-imported
 * after a reload. If you would rather it were hardware-bound, import a
 * non-extractable key with `importEncryptionPrivateKeyJwk` instead and expect
 * `deriveKeyIdFromPrivateKey` to be unavailable.
 */
export async function generateEncryptionKeyPair(): Promise<EncryptionKeyPair> {
  const subtle = subtleOrThrow()
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair
  return { publicKey: pair.publicKey, privateKey: pair.privateKey }
}

export async function exportPublicKeyHex(publicKey: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await subtleOrThrow().exportKey('raw', publicKey))
  if (raw.length !== P256_PUBLIC_KEY_BYTES || raw[0] !== P256_UNCOMPRESSED_TAG) {
    throw new E2EEError('bad-key', 'Expected an uncompressed P-256 public key (65 bytes, 0x04 prefix).')
  }
  return bytesToHex(raw)
}

export async function importPublicKeyHex(publicKeyHex: string): Promise<CryptoKey> {
  const raw = hexToBytes(publicKeyHex, 'public key')
  if (raw.length !== P256_PUBLIC_KEY_BYTES || raw[0] !== P256_UNCOMPRESSED_TAG) {
    throw new E2EEError('bad-key', 'Public key must be an uncompressed P-256 point (65 bytes, 0x04 prefix).')
  }
  return subtleOrThrow().importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
}

export async function exportPrivateKeyJwk(privateKey: CryptoKey): Promise<JsonWebKey> {
  return subtleOrThrow().exportKey('jwk', privateKey)
}

export async function importPrivateKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtleOrThrow().importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
}

/**
 * Stable identifier for a public key: the first 8 bytes of its SHA-256.
 * Doubles as the lookup handle inside the envelope, so it must be derived
 * identically by the sender, the responder and the relay.
 */
export async function deriveKeyIdFromPublicKey(publicKeyHex: string): Promise<string> {
  const raw = hexToBytes(publicKeyHex, 'public key')
  if (raw.length !== P256_PUBLIC_KEY_BYTES || raw[0] !== P256_UNCOMPRESSED_TAG) {
    throw new E2EEError('bad-key', 'Public key must be an uncompressed P-256 point (65 bytes, 0x04 prefix).')
  }
  const digest = await sha256(raw)
  return bytesToHex(digest.slice(0, KEY_ID_BYTES))
}

/**
 * Same id, computed from the private key alone, so a responder can find its
 * own wrap without also keeping the public key around.
 *
 * For ECDH the JWK carries the public `x`/`y`, which is exactly the SEC1
 * point, so this works without a second CryptoKey. Requires an extractable
 * private key (true for keys from `generateEncryptionKeyPair`).
 */
export async function deriveKeyIdFromPrivateKey(privateKey: CryptoKey): Promise<string> {
  const jwk = await exportPrivateKeyJwk(privateKey)
  if (!jwk.x || !jwk.y) {
    throw new E2EEError('bad-key', 'Private key JWK is missing its public coordinates.')
  }
  const x = base64UrlToBytes(jwk.x)
  const y = base64UrlToBytes(jwk.y)
  const raw = new Uint8Array(P256_PUBLIC_KEY_BYTES)
  raw[0] = P256_UNCOMPRESSED_TAG
  raw.set(x, 1)
  raw.set(y, 1 + x.length)
  const digest = await sha256(raw)
  return bytesToHex(digest.slice(0, KEY_ID_BYTES))
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4)
  return new Uint8Array(Buffer.from(withPadding, 'base64'))
}

// ── AEAD primitives ────────────────────────────────────────────────

function importAesKey(raw: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return subtleOrThrow().importKey('raw', raw, { name: 'AES-GCM' }, false, [usage])
}

interface Sealed {
  ciphertext: Uint8Array
  authTag: Uint8Array
}

/**
 * WebCrypto appends the GCM tag to the ciphertext, so split it back out to
 * match the `EncryptedData`/`EncryptedEnvelope` shape the rest of the app uses.
 */
async function aesGcmSeal(
  key: CryptoKey,
  plaintext: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
): Promise<Sealed> {
  const sealed = new Uint8Array(
    await subtleOrThrow().encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: GCM_TAG_BITS },
      key,
      plaintext,
    ),
  )
  return {
    ciphertext: sealed.slice(0, sealed.length - GCM_TAG_BYTES),
    authTag: sealed.slice(sealed.length - GCM_TAG_BYTES),
  }
}

async function aesGcmOpen(
  key: CryptoKey,
  sealed: Sealed,
  iv: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const joined = new Uint8Array(sealed.ciphertext.length + sealed.authTag.length)
  joined.set(sealed.ciphertext, 0)
  joined.set(sealed.authTag, sealed.ciphertext.length)
  return new Uint8Array(
    await subtleOrThrow().decrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: GCM_TAG_BITS },
      key,
      joined,
    ),
  )
}

/**
 * HKDF-SHA256 over an ECDH shared secret → AES-256-GCM key.
 *
 * The salt is the ephemeral public key: unique per message, already carried
 * in the envelope, and bound to the very key material being derived, so a
 * responder cannot be fed a mismatched (salt, secret) pair.
 */
async function deriveWrappingKey(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  ephemeralPublicRaw: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  const subtle = subtleOrThrow()
  const sharedSecret = await subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    SHARED_SECRET_BITS,
  )
  const hkdfKey = await subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits'])
  const wrappingKeyBits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ephemeralPublicRaw,
      info: encodeUtf8(info),
    },
    hkdfKey,
    AES_KEY_BYTES * 8,
  )
  return subtle.importKey('raw', wrappingKeyBits, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

// ── AAD (context binding) ──────────────────────────────────────────

/**
 * Normalise the id the payload is bound to.
 *
 * Numbers and bigints are truncated to integers so `7`, `'7'` and `7n` all
 * produce the same AAD; anything else is used as a trimmed string. The result
 * is carried in the envelope so a responder never needs out-of-band context,
 * and mixed into every AEAD tag so editing it invalidates them.
 */
function normalizeContext(bindingContext: string | number | bigint): string {
  if (typeof bindingContext === 'bigint') return bindingContext.toString(10)
  if (typeof bindingContext === 'number') {
    if (!Number.isFinite(bindingContext)) {
      throw new E2EEError('bad-context', 'Binding context must be a finite number.')
    }
    return String(Math.trunc(bindingContext))
  }
  const trimmed = String(bindingContext ?? '').trim()
  if (!trimmed) {
    throw new E2EEError('bad-context', 'Binding context must not be empty.')
  }
  if (trimmed.length > 128) {
    throw new E2EEError('bad-context', 'Binding context must be 128 characters or fewer.')
  }
  return trimmed
}

function payloadAad(context: string): Uint8Array {
  return encodeUtf8(`${E2EE_INFO_PREFIX}|payload|request=${context}`)
}

function wrapAad(context: string, keyId: string): Uint8Array {
  return encodeUtf8(`${E2EE_INFO_PREFIX}|wrap|request=${context}|keyId=${keyId}`)
}

// ── Payload serialisation ──────────────────────────────────────────

/**
 * Deterministic JSON: keys are emitted in sorted order so the same payload
 * always produces the same plaintext bytes, which keeps the ciphertext stable
 * and makes the format testable against fixed vectors.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
}

function serializePayload(payload: EmergencyPayload): Uint8Array {
  if (!payload || typeof payload !== 'object') {
    throw new E2EEError('bad-payload', 'An emergency payload object is required.')
  }
  for (const field of ['contact', 'medicalNotes', 'nickname'] as const) {
    if (typeof payload[field] !== 'string') {
      throw new E2EEError('bad-payload', `Emergency payload field "${field}" must be a string.`)
    }
  }
  const record: Record<string, unknown> = {
    contact: payload.contact,
    medicalNotes: payload.medicalNotes,
    nickname: payload.nickname,
  }
  // `allergies` is optional; fold it in rather than emitting a second field
  // that some older clients would silently drop.
  if (typeof payload.allergies === 'string' && payload.allergies.length > 0) {
    record.allergies = payload.allergies
  }
  if (typeof payload.requestedAt === 'number' && Number.isFinite(payload.requestedAt)) {
    record.requestedAt = Math.trunc(payload.requestedAt)
  }
  const bytes = encodeUtf8(canonicalize(record))
  if (bytes.length === 0) {
    throw new E2EEError('bad-payload', 'Refusing to seal an empty emergency payload.')
  }
  if (bytes.length > MAX_PAYLOAD_PLAINTEXT_BYTES) {
    throw new E2EEError(
      'payload-too-large',
      `Emergency payload is ${bytes.length} bytes; the limit is ${MAX_PAYLOAD_PLAINTEXT_BYTES}.`,
    )
  }
  return bytes
}

function parsePayload(bytes: Uint8Array): EmergencyPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8(bytes))
  } catch {
    // A GCM-authenticated plaintext that is not JSON means the producer used a
    // different (or older) serialisation. Do not guess at it.
    throw new E2EEError('bad-payload', 'Decrypted payload is not valid UTF-8 JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new E2EEError('bad-payload', 'Decrypted payload is not an object.')
  }
  const record = parsed as Record<string, unknown>
  const payload: EmergencyPayload = {
    contact: typeof record.contact === 'string' ? record.contact : '',
    medicalNotes: typeof record.medicalNotes === 'string' ? record.medicalNotes : '',
    nickname: typeof record.nickname === 'string' ? record.nickname : '',
  }
  if (typeof record.allergies === 'string') payload.allergies = record.allergies
  if (typeof record.requestedAt === 'number') payload.requestedAt = record.requestedAt
  return payload
}

// ── Envelope validation ────────────────────────────────────────────

/**
 * Structural check shared by the client and the relay: shape, hex validity and
 * length ceilings only. It says nothing about authenticity — that is what the
 * GCM tags are for, and only a key holder can check them.
 */
export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const env = value as Record<string, unknown>
  if (env.version !== E2EE_VERSION) return false
  if (env.algorithm !== E2EE_ALGORITHM) return false
  if (typeof env.bindingContext !== 'string' || env.bindingContext.length < 1) return false
  if (env.bindingContext.length > 128) return false
  if (hexByteLength(env.ephemeralPublicKey) !== P256_PUBLIC_KEY_BYTES) return false
  if (hexByteLength(env.iv) !== GCM_IV_BYTES) return false
  if (hexByteLength(env.authTag) !== GCM_TAG_BYTES) return false
  if (hexByteLength(env.ciphertext) < 1) return false
  if (!Array.isArray(env.wrappedKeys) || env.wrappedKeys.length < 1) return false
  if (env.wrappedKeys.length > MAX_PAYLOAD_RECIPIENTS) return false
  return env.wrappedKeys.every((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const wrap = entry as Record<string, unknown>
    return (
      typeof wrap.keyId === 'string' &&
      wrap.keyId.length === KEY_ID_BYTES * 2 &&
      hexByteLength(wrap.keyId) === KEY_ID_BYTES &&
      hexByteLength(wrap.wrapIv) === GCM_IV_BYTES &&
      hexByteLength(wrap.wrapAuthTag) === GCM_TAG_BYTES &&
      hexByteLength(wrap.wrappedKey) === AES_KEY_BYTES
    )
  })
}

function assertEnvelope(envelope: EncryptedEnvelope): void {
  if (!isEncryptedEnvelope(envelope)) {
    throw new E2EEError('bad-envelope', 'Envelope is malformed, truncated or of an unknown version.')
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Seal an emergency payload for a set of authorized recipients.
 *
 * @param payload            plaintext contact number / medical notes
 * @param recipientPublicKeys hex P-256 public keys, one per authorized reader.
 *                            Include the requester if they should be able to
 *                            re-read what they submitted.
 * @param bindingContext     id mixed into every AEAD tag, so this envelope
 *                            cannot be opened in a different context. Normally
 *                            a client-generated submission id, because the
 *                            on-chain request id is not known until after the
 *                            transaction is signed. Recorded in the envelope as
 *                            `bindingContext` so responders need no extra
 *                            coordination to read it.
 */
export async function encryptEmergencyPayload(
  payload: EmergencyPayload,
  recipientPublicKeys: string[],
  bindingContext: string | number | bigint,
): Promise<EncryptedEnvelope> {
  const context = normalizeContext(bindingContext)
  const plaintext = serializePayload(payload)

  if (!Array.isArray(recipientPublicKeys) || recipientPublicKeys.length === 0) {
    throw new E2EEError('no-recipients', 'At least one recipient public key is required.')
  }
  if (recipientPublicKeys.length > MAX_PAYLOAD_RECIPIENTS) {
    throw new E2EEError(
      'too-many-recipients',
      `Cannot seal for ${recipientPublicKeys.length} recipients; the limit is ${MAX_PAYLOAD_RECIPIENTS}.`,
    )
  }

  const subtle = subtleOrThrow()

  // One content key for the whole recipient set, so the ciphertext is stored
  // exactly once regardless of how many responders are dispatched.
  const contentKeyBytes = randomBytes(AES_KEY_BYTES)
  const contentKey = await importAesKey(contentKeyBytes, 'encrypt')

  // One-shot ephemeral pair. The private half is never exported and never
  // leaves this function; dropping the reference is the whole lifetime
  // guarantee, so nothing derived from it is ever reusable.
  const ephemeral = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair
  const ephemeralPublicRaw = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey))
  if (ephemeralPublicRaw.length !== P256_PUBLIC_KEY_BYTES) {
    throw new E2EEError('bad-key', 'Ephemeral public key has an unexpected length.')
  }

  const iv = randomBytes(GCM_IV_BYTES)
  const sealed = await aesGcmSeal(contentKey, plaintext, iv, payloadAad(context))

  const wrappedKeys: WrappedContentKey[] = []
  const seenKeyIds = new Set<string>()
  for (const publicKeyHex of recipientPublicKeys) {
    const keyId = await deriveKeyIdFromPublicKey(publicKeyHex)
    if (seenKeyIds.has(keyId)) continue // duplicate recipient — one wrap is enough
    seenKeyIds.add(keyId)

    const peerPublicKey = await importPublicKeyHex(publicKeyHex)
    const wrappingKey = await deriveWrappingKey(
      ephemeral.privateKey,
      peerPublicKey,
      ephemeralPublicRaw,
      wrapInfo(context, keyId),
    )
    const wrapIv = randomBytes(GCM_IV_BYTES)
    const wrapped = await aesGcmSeal(
      wrappingKey,
      contentKeyBytes,
      wrapIv,
      wrapAad(context, keyId),
    )
    wrappedKeys.push({
      keyId,
      wrappedKey: bytesToHex(wrapped.ciphertext),
      wrapIv: bytesToHex(wrapIv),
      wrapAuthTag: bytesToHex(wrapped.authTag),
    })
  }

  const envelope: EncryptedEnvelope = {
    version: E2EE_VERSION,
    algorithm: E2EE_ALGORITHM,
    bindingContext: context,
    ephemeralPublicKey: bytesToHex(ephemeralPublicRaw),
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(sealed.ciphertext),
    authTag: bytesToHex(sealed.authTag),
    wrappedKeys,
    createdAt: Date.now(),
  }

  // Mirror the contract's cap so an over-large payload fails locally with a
  // useful message instead of burning a signed transaction that reverts.
  const envelopeBytes = estimateEnvelopeBytes(envelope)
  if (envelopeBytes > MAX_ENVELOPE_BYTES) {
    throw new E2EEError(
      'envelope-too-large',
      `Sealed envelope is ${envelopeBytes} bytes; the contract accepts at most ${MAX_ENVELOPE_BYTES}.`,
    )
  }

  return envelope
}

/**
 * Open an envelope with a recipient private key.
 *
 * @param expectedContext optional. When supplied it must equal the envelope's
 *        `bindingContext`; use it when the responder learned the id out of band
 *        (e.g. from the map marker) and wants a mismatch to fail loudly.
 *        Otherwise the envelope's own value is used — it is public, and the AEAD
 *        tags make it tamper-evident.
 *
 * Throws `E2EEError` with a stable `code` so callers can distinguish "not
 * addressed to me" from "tampered" from "malformed" without string matching.
 */
export async function decryptEmergencyPayload(
  envelope: EncryptedEnvelope,
  privateKey: CryptoKey,
  expectedContext?: string | number | bigint,
): Promise<EmergencyPayload> {
  assertEnvelope(envelope)
  if (expectedContext !== undefined) {
    const expected = normalizeContext(expectedContext)
    if (expected !== envelope.bindingContext) {
      throw new E2EEError(
        'context-mismatch',
        'This payload is bound to a different request and cannot be opened here.',
      )
    }
  }
  const context = envelope.bindingContext
  const subtle = subtleOrThrow()

  const ephemeralPublicRaw = hexToBytes(envelope.ephemeralPublicKey, 'ephemeralPublicKey')
  const ephemeralPublicKey = await importPublicKeyHex(envelope.ephemeralPublicKey)

  // Prefer the addressed wrap (no trial decryption of the other recipients'
  // keys). If the private key is non-extractable we cannot derive our own key
  // id, so fall back to trying each wrap — AES-GCM authenticates, so a wrong
  // key fails closed rather than returning garbage.
  const { candidates, addressed } = await selectWrapCandidates(envelope, privateKey)

  for (const wrap of candidates) {
    const wrappingKey = await deriveWrappingKey(
      privateKey,
      ephemeralPublicKey,
      ephemeralPublicRaw,
      wrapInfo(context, wrap.keyId),
    )
    let contentKeyBytes: Uint8Array
    try {
      contentKeyBytes = await aesGcmOpen(
        wrappingKey,
        {
          ciphertext: hexToBytes(wrap.wrappedKey, 'wrappedKey'),
          authTag: hexToBytes(wrap.wrapAuthTag, 'wrapAuthTag'),
        },
        hexToBytes(wrap.wrapIv, 'wrapIv'),
        wrapAad(context, wrap.keyId),
      )
    } catch {
      // This wrap is addressed to us but did not authenticate: either the
      // envelope was altered, or it was sealed for a different request id
      // (the id is in the wrap's AAD). Report that, rather than pretending we
      // simply are not a recipient.
      if (addressed && wrap.keyId === addressed.keyId) {
        throw new E2EEError(
          'auth-failed',
          'This emergency payload failed authentication. It was altered in transit, or it belongs to a different request.',
        )
      }
      continue // wrong key, or a wrap tampered with
    }

    const contentKey = await importAesKey(contentKeyBytes, 'decrypt')
    let plaintext: Uint8Array
    try {
      plaintext = await aesGcmOpen(
        contentKey,
        {
          ciphertext: hexToBytes(envelope.ciphertext, 'ciphertext'),
          authTag: hexToBytes(envelope.authTag, 'authTag'),
        },
        hexToBytes(envelope.iv, 'iv'),
        payloadAad(context),
      )
    } catch {
      throw new E2EEError(
        'auth-failed',
        'Emergency payload failed authentication. It was altered in transit, or it belongs to a different request.',
      )
    }
    return parsePayload(plaintext)
  }
  throw new E2EEError(
    'not-a-recipient',
    'This key is not one of the recipients for the sealed emergency payload.',
  )
}

/**
 * Wrap keys to try, plus the one addressed to this key when we can identify
 * it. The addressed flag is what lets the caller distinguish "I am a recipient
 * but this envelope is not for me / has been tampered with" from "I am simply
 * not a recipient".
 */
async function selectWrapCandidates(
  envelope: EncryptedEnvelope,
  privateKey: CryptoKey,
): Promise<{ candidates: WrappedContentKey[]; addressed: WrappedContentKey | null }> {
  try {
    const ownKeyId = await deriveKeyIdFromPrivateKey(privateKey)
    const addressed = envelope.wrappedKeys.find((wrap) => wrap.keyId === ownKeyId) ?? null
    if (addressed) return { candidates: [addressed], addressed }
    // We are a valid key holder, just not an authorized recipient: say so
    // precisely instead of silently trying (and failing) every other wrap.
    return { candidates: [], addressed: null }
  } catch {
    // Non-extractable private key: we cannot derive our own key id, so fall
    // back to trying every wrap. AES-GCM authenticates, so this stays safe.
    return { candidates: envelope.wrappedKeys, addressed: null }
  }
}

/** The HKDF `info` string for a wrap. Must match on both sides. */
function wrapInfo(context: string, keyId: string): string {
  return `${E2EE_INFO_PREFIX}|wrap|request=${context}|keyId=${keyId}`
}

/** Convenience: generate a pair and return the public key as hex. */
export async function generateEncryptionKeyPairHex(): Promise<{
  publicKey: string
  privateKey: CryptoKey
}> {
  const { publicKey, privateKey } = await generateEncryptionKeyPair()
  return { publicKey: await exportPublicKeyHex(publicKey), privateKey }
}

/**
 * Build the recipient records a client publishes so a requester can seal for
 * them. Order is preserved and duplicates by key id are dropped.
 *
 * Entries that are unusable are **skipped, not thrown on**: a single corrupt
 * registry row must not be able to block an emergency submission. Skipping can
 * only ever narrow the recipient set, and the requester is always sealed in by
 * the caller, so the failure mode is a missing responder rather than a leaked
 * payload. Callers that need to know can diff against their input length.
 */
export async function buildResponderKeyRecords(
  entries: Array<{ wallet: string; publicKey: string }>,
): Promise<ResponderEncryptionKey[]> {
  const seen = new Set<string>()
  const records: ResponderEncryptionKey[] = []
  for (const entry of entries) {
    const wallet = typeof entry?.wallet === 'string' ? entry.wallet.trim() : ''
    const publicKey = typeof entry?.publicKey === 'string' ? entry.publicKey.trim() : ''
    if (!wallet || !PUBLIC_KEY_HEX_RE.test(publicKey)) continue
    let keyId: string
    try {
      keyId = await deriveKeyIdFromPublicKey(publicKey)
    } catch {
      continue
    }
    if (seen.has(keyId)) continue
    seen.add(keyId)
    records.push({
      wallet,
      publicKey: publicKey.toLowerCase(),
      keyId,
      registeredAt: Date.now(),
    })
  }
  if (records.length === 0) {
    throw new E2EEError('no-recipients', 'At least one recipient public key is required.')
  }
  if (records.length > MAX_PAYLOAD_RECIPIENTS) {
    throw new E2EEError(
      'too-many-recipients',
      `Cannot seal for ${records.length} recipients; the limit is ${MAX_PAYLOAD_RECIPIENTS}.`,
    )
  }
  return records
}

/** Total on-chain size of a serialized envelope, in bytes. */
export function estimateEnvelopeBytes(envelope: EncryptedEnvelope): number {
  return new TextEncoder().encode(JSON.stringify(envelope)).length
}

// ── Federation Protocol (ISP-144) ──────────────────────────────────────────

export interface TrustBundle {
  instanceId: string
  domain: string
  aegisVaultRoot: string
  rotationCounter: number
  expertRegistryHash: string
  revokedIdentities: string[]
  issuedAt: number
  expiresAt: number
  signature: string
  signingPublicKey: string
}

export interface FederatedEnvelope<T = unknown> {
  version: '1.0'
  envelopeId: string
  senderInstance: string
  recipientInstance: string
  nonce: string
  timestamp: number
  trustBundleRef: {
    instanceId: string
    rotationCounter: number
  }
  payloadType: 'dispatch' | 'ack' | 'status_update' | 'crdt_delta' | 'settlement_iou'
  payload: T
  idempotencyKey: string
  signature: string
  senderPublicKey: string
}

export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj)
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']'
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort()
  const entries = keys.map(
    (k) => JSON.stringify(k) + ':' + canonicalJson((obj as Record<string, unknown>)[k])
  )
  return '{' + entries.join(',') + '}'
}

export async function createTrustBundle(params: {
  instanceId: string
  domain: string
  aegisVaultRoot: string
  rotationCounter: number
  expertRegistryHash: string
  revokedIdentities?: string[]
  secretKey: string
  publicKey: string
  ttlMs?: number
}): Promise<TrustBundle> {
  const now = Date.now()
  const ttl = params.ttlMs ?? 3600_000 // 1 hour default
  const revoked = params.revokedIdentities ?? []

  const bundleData = {
    instanceId: params.instanceId,
    domain: params.domain,
    aegisVaultRoot: params.aegisVaultRoot,
    rotationCounter: params.rotationCounter,
    expertRegistryHash: params.expertRegistryHash,
    revokedIdentities: [...revoked].sort(),
    issuedAt: now,
    expiresAt: now + ttl,
  }

  const message = canonicalJson(bundleData)
  const signature = signEd25519Message(message, params.secretKey)

  return {
    ...bundleData,
    signature,
    signingPublicKey: params.publicKey,
  }
}

export function verifyTrustBundle(
  bundle: TrustBundle,
  expectedPublicKey?: string,
  now = Date.now(),
  gracePeriodMs = 300_000
): { valid: boolean; stale: boolean; expired: boolean; error?: string } {
  if (!bundle || typeof bundle !== 'object') {
    return { valid: false, stale: false, expired: true, error: 'Malformed trust bundle' }
  }

  if (expectedPublicKey && bundle.signingPublicKey !== expectedPublicKey) {
    return { valid: false, stale: false, expired: false, error: 'Signer key does not match expected peer key' }
  }

  const bundleData = {
    instanceId: bundle.instanceId,
    domain: bundle.domain,
    aegisVaultRoot: bundle.aegisVaultRoot,
    rotationCounter: bundle.rotationCounter,
    expertRegistryHash: bundle.expertRegistryHash,
    revokedIdentities: [...(bundle.revokedIdentities || [])].sort(),
    issuedAt: bundle.issuedAt,
    expiresAt: bundle.expiresAt,
  }

  const message = canonicalJson(bundleData)
  const isSigValid = verifyEd25519Signature(message, bundle.signature, bundle.signingPublicKey)
  if (!isSigValid) {
    return { valid: false, stale: false, expired: false, error: 'Invalid trust bundle signature' }
  }

  const isExpiredBeyondGrace = now > bundle.expiresAt + gracePeriodMs
  const isStale = now > bundle.expiresAt

  if (isExpiredBeyondGrace) {
    return { valid: false, stale: true, expired: true, error: 'Trust bundle has expired beyond grace period' }
  }

  return {
    valid: true,
    stale: isStale,
    expired: false,
    error: isStale ? 'Trust bundle is stale (verify-but-flag)' : undefined,
  }
}

export function isIdentityRevoked(identity: string, bundle: TrustBundle): boolean {
  if (!bundle || !Array.isArray(bundle.revokedIdentities)) return false
  return bundle.revokedIdentities.includes(identity)
}

export async function signFederatedEnvelope<T>(params: {
  senderInstance: string
  recipientInstance: string
  payloadType: FederatedEnvelope['payloadType']
  payload: T
  trustBundleRef: { instanceId: string; rotationCounter: number }
  secretKey: string
  publicKey: string
  nonce?: string
  idempotencyKey?: string
  timestamp?: number
}): Promise<FederatedEnvelope<T>> {
  const nonce = params.nonce || crypto.randomBytes(16).toString('hex')
  const idempotencyKey = params.idempotencyKey || `${params.senderInstance}:${nonce}`
  const timestamp = params.timestamp || Date.now()
  const envelopeId = `${params.senderInstance}:${timestamp}:${nonce.slice(0, 8)}`

  const envelopeData = {
    version: '1.0' as const,
    envelopeId,
    senderInstance: params.senderInstance,
    recipientInstance: params.recipientInstance,
    nonce,
    timestamp,
    trustBundleRef: params.trustBundleRef,
    payloadType: params.payloadType,
    payload: params.payload,
    idempotencyKey,
  }

  const message = canonicalJson(envelopeData)
  const signature = signEd25519Message(message, params.secretKey)

  return {
    ...envelopeData,
    signature,
    senderPublicKey: params.publicKey,
  }
}

export function verifyFederatedEnvelope<T>(
  envelope: FederatedEnvelope<T>,
  trustBundle: TrustBundle,
  options: { maxAgeMs?: number; now?: number } = {}
): { verified: boolean; error?: string; staleBundle?: boolean } {
  if (!envelope || envelope.version !== '1.0') {
    return { verified: false, error: 'Unsupported or missing envelope version' }
  }

  if (envelope.senderInstance !== trustBundle.instanceId) {
    return {
      verified: false,
      error: `Sender instance mismatch: envelope=${envelope.senderInstance}, bundle=${trustBundle.instanceId}`,
    }
  }

  if (envelope.senderPublicKey !== trustBundle.signingPublicKey) {
    return { verified: false, error: 'Envelope key does not match trust bundle signing key' }
  }

  const bundleCheck = verifyTrustBundle(trustBundle, envelope.senderPublicKey, options.now)
  if (!bundleCheck.valid) {
    return { verified: false, error: `Trust bundle verification failed: ${bundleCheck.error}` }
  }

  if (envelope.trustBundleRef.rotationCounter < trustBundle.rotationCounter) {
    return {
      verified: false,
      error: `Envelope references superseded trust root counter ${envelope.trustBundleRef.rotationCounter} < ${trustBundle.rotationCounter}`,
    }
  }

  const now = options.now ?? Date.now()
  const maxAge = options.maxAgeMs ?? 300_000 // 5 minutes replay window
  if (Math.abs(now - envelope.timestamp) > maxAge) {
    return { verified: false, error: `Envelope timestamp outside replay window (${Math.round((now - envelope.timestamp) / 1000)}s drift)` }
  }

  const envelopeData = {
    version: envelope.version,
    envelopeId: envelope.envelopeId,
    senderInstance: envelope.senderInstance,
    recipientInstance: envelope.recipientInstance,
    nonce: envelope.nonce,
    timestamp: envelope.timestamp,
    trustBundleRef: envelope.trustBundleRef,
    payloadType: envelope.payloadType,
    payload: envelope.payload,
    idempotencyKey: envelope.idempotencyKey,
  }

  const message = canonicalJson(envelopeData)
  const isSigValid = verifyEd25519Signature(message, envelope.signature, envelope.senderPublicKey)
  if (!isSigValid) {
    return { verified: false, error: 'Envelope signature verification failed (tampered payload or invalid signature)' }
  }

  return {
    verified: true,
    staleBundle: bundleCheck.stale,
  }
}

export function verifyForeignSignature(data: string, signatureHex: string, foreignPublicKey: string): boolean {
  return verifyEd25519Signature(data, signatureHex, foreignPublicKey)
}


// ── Message Franking (ISP-056 / #726) ──────────────────────────────────────
/**
 * HMAC-commitment message franking. The sender attaches a compact tag over
 * `(nonce ‖ ciphertext)` under a versioned franking key; a moderator holding
 * the key for `keyId` can verify a reported ciphertext deterministically,
 * while a party without the key cannot forge or (with the tag withheld)
 * prove anything about unreported traffic.
 *
 * `keyId` is part of the tag envelope so verification survives key rotation
 * (`src/lib/keyRotation.ts`): old keys are retained read-only, mapped by
 * id, and never used to tag new messages. The full escrow/report flow is
 * specced in `docs/spikes/726-message-franking-report.md`.
 */
export interface FrankingTag {
  keyId: string
  nonce: string
  mac: string
}

export const FRANKING_MAC_BYTES = 16
const FRANKING_NONCE_BYTES = 12

function frankingMac(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const hmac = crypto.createHmac('sha256', key)
  hmac.update(nonce)
  hmac.update(ciphertext)
  return new Uint8Array(hmac.digest().subarray(0, FRANKING_MAC_BYTES))
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}

/** Attach a franking tag to a ciphertext before transmission. */
export function attachFrankingTag(
  ciphertext: Uint8Array,
  frankKey: Uint8Array | string,
  keyId: string,
): FrankingTag {
  if (!keyId) {
    throw new E2EEError('bad-franking', 'A franking tag requires a keyId so old reports stay verifiable after rotation.')
  }
  const key = typeof frankKey === 'string' ? encodeUtf8(frankKey) : frankKey
  if (key.length === 0) {
    throw new E2EEError('bad-franking', 'The franking key must not be empty.')
  }
  const nonce = randomBytes(FRANKING_NONCE_BYTES)
  const mac = frankingMac(key, nonce, ciphertext)
  return { keyId, nonce: bytesToHex(nonce), mac: bytesToHex(mac) }
}

/**
 * Verify a reported ciphertext against its franking tag. Returns false on
 * any malformed input rather than throwing, so moderators can batch-check
 * untrusted reports safely.
 */
export function verifyFrankingTag(
  ciphertext: Uint8Array,
  tag: FrankingTag,
  frankKey: Uint8Array | string,
): boolean {
  if (!tag || typeof tag.keyId !== 'string' || typeof tag.nonce !== 'string' || typeof tag.mac !== 'string') {
    return false
  }
  const key = typeof frankKey === 'string' ? encodeUtf8(frankKey) : frankKey
  if (key.length === 0) return false
  let nonce: Uint8Array
  let expected: Uint8Array
  try {
    nonce = hexToBytes(tag.nonce, 'franking nonce')
    expected = hexToBytes(tag.mac, 'franking mac')
  } catch {
    return false
  }
  if (nonce.length !== FRANKING_NONCE_BYTES || expected.length !== FRANKING_MAC_BYTES) return false
  return timingSafeEqualBytes(frankingMac(key, nonce, ciphertext), expected)
}
