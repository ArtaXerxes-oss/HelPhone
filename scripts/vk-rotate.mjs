#!/usr/bin/env node
/**
 * VK rotation gate (ISP-051, issue #936).
 *
 * A rotation is safe only when every verifier layer holds the same VK hash:
 *   manifest   public/zk-assets/vk-manifest.json   (served to the PWA and the server)
 *   recursive  circuits/recursive_verifier/inner-vk.json (innerVkHash pin)
 *   onchain    Soroban vk_hash, passed with --onchain (contract state is not read from this repo)
 *
 * Usage:
 *   node scripts/vk-rotate.mjs check [--onchain 0x<hash>]
 *       Exits 1 on any missing or disagreeing layer. This is the partial-rotation block.
 *
 *   VK_MANIFEST_SIGNING_KEY=/path/to/private.jwk \
 *   node scripts/vk-rotate.mjs publish --vk-hash 0x<hash> --vk-version <n> --grace-hours <h>
 *       Writes a signed manifest. Refused unless the recursive pin already equals
 *       --vk-hash, so the verifier is pinned before the PWA trusts the new VK.
 *
 * Not automated here: compiling the circuit (`circuits/recursive_verifier/build.sh`,
 * then `check-recursive-verifier-vk.mjs --write`), deploying the PWA, and the
 * on-chain vk_hash upgrade. The rotation is complete only when `check --onchain`
 * exits 0.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  parseVkManifest,
  signVkManifest,
  verifyVkManifest,
  VK_CIRCUIT,
  VK_MANIFEST_PUBLIC_KEY_JWK,
} from '../src/lib/vkManifest.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const MANIFEST_PATH = resolve(ROOT, 'public/zk-assets/vk-manifest.json')
export const RECURSIVE_PIN_PATH = resolve(ROOT, 'circuits/recursive_verifier/inner-vk.json')
const HASH_RE = /^0x[0-9a-f]{64}$/
const MAX_GRACE_HOURS = 24 * 30

export function normalizeHash(value) {
  if (typeof value !== 'string') return null
  const lower = value.trim().toLowerCase()
  return HASH_RE.test(lower) ? lower : null
}

/**
 * Pure. `layers` maps layer name to hash (or null when that layer did not report).
 * Passes only when every layer reports and all of them agree.
 */
export function checkLayerConsistency({ layers }) {
  const values = {}
  for (const [name, raw] of Object.entries(layers)) values[name] = normalizeHash(raw)

  const missing = Object.keys(values).filter((name) => values[name] === null)
  const distinct = [...new Set(Object.values(values).filter((v) => v !== null))]

  if (missing.length > 0) {
    return {
      ok: false,
      values,
      missing,
      distinct,
      message: `layer(s) not reporting a valid VK hash: ${missing.join(', ')}. Rotation is blocked until every layer reports.`,
    }
  }
  if (distinct.length > 1) {
    const detail = Object.entries(values).map(([name, hash]) => `${name}=${hash}`).join(' ')
    return {
      ok: false,
      values,
      missing,
      distinct,
      message: `partial rotation: layers disagree (${detail}). Rotation is blocked.`,
    }
  }
  return { ok: true, values, missing, distinct, message: `all layers agree on ${distinct[0]}` }
}

/**
 * Pure guard for `publish`. Throws with an actionable message when the rotation
 * is out of order or would not advance the version.
 */
export function assertPublishAllowed({ vkVersion, vkHash, previousManifest, recursivePin }) {
  if (!Number.isSafeInteger(vkVersion) || vkVersion < 1) throw new Error('--vk-version must be a positive integer')
  if (!normalizeHash(vkHash)) throw new Error('--vk-hash must be 0x followed by 64 lowercase hex digits')
  if (previousManifest) {
    if (vkVersion <= previousManifest.vkVersion) {
      throw new Error(`--vk-version ${vkVersion} must be greater than the current manifest version ${previousManifest.vkVersion}`)
    }
    if (normalizeHash(vkHash) === previousManifest.vkHash) {
      throw new Error('--vk-hash equals the current manifest hash; nothing to rotate')
    }
  }
  const pin = normalizeHash(recursivePin)
  if (pin !== normalizeHash(vkHash)) {
    throw new Error(
      `recursive verifier pin is ${pin ?? 'unset'}, expected ${normalizeHash(vkHash)}. ` +
        'Build and pin the circuit first: bash circuits/recursive_verifier/build.sh, then node scripts/check-recursive-verifier-vk.mjs --write.',
    )
  }
}

/** Pure. Builds the unsigned manifest. `supersedes` keeps every earlier hash so a stale VK stays rejected. */
export function buildUnsignedManifest({ vkVersion, vkHash, previousManifest, graceHours, now = new Date() }) {
  const supersedes = previousManifest
    ? [...new Set([previousManifest.vkHash, ...previousManifest.supersedes])]
    : []
  const issuedAt = new Date(now).toISOString()
  const graceUntil = new Date(new Date(now).getTime() + graceHours * 3_600_000).toISOString()
  return {
    version: 1,
    circuit: VK_CIRCUIT,
    vkVersion,
    vkHash: normalizeHash(vkHash),
    supersedes,
    issuedAt,
    graceUntil,
  }
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readLayers(onchain) {
  const manifest = readJsonIfExists(MANIFEST_PATH)
  const pin = readJsonIfExists(RECURSIVE_PIN_PATH)
  return {
    manifest: manifest ? parseVkManifest(manifest).vkHash : null,
    recursive: pin?.innerVkHash ?? null,
    onchain: onchain ?? null,
  }
}

function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`--${key} needs a value`)
    flags[key] = next
    i++
  }
  return flags
}

const USAGE = `usage:
  node scripts/vk-rotate.mjs check [--onchain 0x<hash>]
  VK_MANIFEST_SIGNING_KEY=<private.jwk> node scripts/vk-rotate.mjs publish --vk-hash 0x<hash> --vk-version <n> --grace-hours <h>`

async function runCheck(flags) {
  const layers = readLayers(flags.onchain)
  const result = checkLayerConsistency({ layers })
  for (const [name, hash] of Object.entries(result.values)) console.log(`  ${name.padEnd(10)} ${hash ?? '(not reporting)'}`)
  console.log(result.ok ? `OK: ${result.message}` : `BLOCKED: ${result.message}`)
  return result.ok ? 0 : 1
}

async function runPublish(flags) {
  const vkHash = normalizeHash(flags['vk-hash'])
  const vkVersion = Number(flags['vk-version'])
  const graceHours = Number(flags['grace-hours'])
  if (!Number.isFinite(graceHours) || graceHours <= 0 || graceHours > MAX_GRACE_HOURS) {
    throw new Error(`--grace-hours must be between 0 and ${MAX_GRACE_HOURS}`)
  }

  const existing = readJsonIfExists(MANIFEST_PATH)
  const previousManifest = existing ? parseVkManifest(existing) : null
  const recursivePin = readJsonIfExists(RECURSIVE_PIN_PATH)?.innerVkHash ?? null
  assertPublishAllowed({ vkVersion, vkHash, previousManifest, recursivePin })

  const keyPath = process.env.VK_MANIFEST_SIGNING_KEY
  if (!keyPath) throw new Error('VK_MANIFEST_SIGNING_KEY must point to the ECDSA P-256 private key (JWK)')
  const privateKeyJwk = JSON.parse(readFileSync(keyPath, 'utf8'))

  const unsigned = buildUnsignedManifest({ vkVersion, vkHash, previousManifest, graceHours })
  const signed = await signVkManifest(unsigned, privateKeyJwk, globalThis.crypto.subtle)

  if (VK_MANIFEST_PUBLIC_KEY_JWK) {
    if (!(await verifyVkManifest(signed, VK_MANIFEST_PUBLIC_KEY_JWK, globalThis.crypto.subtle))) {
      throw new Error('signed manifest does not verify against the pinned public key; check the signing key')
    }
  } else {
    console.warn('warning: VK_MANIFEST_PUBLIC_KEY_JWK is not pinned in src/lib/vkManifest.js; the app will reject this manifest until it is.')
  }

  mkdirSync(dirname(MANIFEST_PATH), { recursive: true })
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(signed, null, 2)}\n`)
  console.log(`published vkVersion ${vkVersion} (${vkHash}) -> ${MANIFEST_PATH}`)
  console.log('next: deploy the PWA, upgrade the on-chain vk_hash, then run:')
  console.log(`  node scripts/vk-rotate.mjs check --onchain ${vkHash}`)
  return 0
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv
  try {
    if (cmd === 'check') return await runCheck(parseFlags(rest))
    if (cmd === 'publish') return await runPublish(parseFlags(rest))
  } catch (err) {
    console.error(`error: ${err.message}`)
    return 1
  }
  console.error(USAGE)
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
