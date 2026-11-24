#!/usr/bin/env node
/**
 * Recursive-verifier VK pin check (#938, ISP-051).
 *
 * The recursive verifier pins the inner `responder_credential` verification
 * key as the public `inner_vk_hash`. This script recomputes that hash from the
 * circuit artifact with the same `createAggregationProver().innerVk()` path the
 * app uses, then compares it with the value committed in
 * `circuits/recursive_verifier/inner-vk.json`. It fails, naming both hashes,
 * when they differ, and it fails closed when no pin is committed yet.
 *
 * Usage:
 *   node scripts/check-recursive-verifier-vk.mjs          # verify (CI)
 *   node scripts/check-recursive-verifier-vk.mjs --write  # re-pin after an intentional circuit change
 *
 * `--write` is only for a reviewed circuit change. Run it after
 * `bash circuits/recursive_verifier/build.sh`, then commit the pin file.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PIN_PATH = resolve(ROOT, 'circuits/recursive_verifier/inner-vk.json')
export const INNER_ARTIFACT = resolve(ROOT, 'circuits/responder_credential/target/responder_credential.json')
const HASH_RE = /^0x[0-9a-f]{64}$/

/**
 * Pure comparison, kept separate from the toolchain so it can be unit tested.
 * Returns `{ ok, message }`. The message always names the committed and
 * computed hashes when they are available.
 */
export function compareInnerVkHash({ committed, computed, committedArtifactSha256 = null, computedArtifactSha256 = null }) {
  const now = String(computed ?? '').toLowerCase()
  if (!committed) {
    return {
      ok: false,
      message:
        `no committed inner VK hash in circuits/recursive_verifier/inner-vk.json ` +
        `(computed ${now}). Pin it with --write after a reviewed build, then commit the pin.`,
    }
  }
  const pinned = String(committed).toLowerCase()
  if (!HASH_RE.test(pinned)) {
    return { ok: false, message: `malformed committed inner VK hash: ${committed}` }
  }
  if (pinned !== now) {
    return {
      ok: false,
      message:
        `inner VK hash drift: committed ${pinned}, computed ${now}. ` +
        `If the circuit change is intentional, re-pin with --write and update every verifier ` +
        `(client vk.json, server/routes/zk.ts, recursive_verifier, Soroban vk_hash) per docs/stellar-zk-runbook.md.`,
    }
  }
  if (committedArtifactSha256 && computedArtifactSha256 && committedArtifactSha256 !== computedArtifactSha256) {
    return {
      ok: false,
      message:
        `circuit artifact drift: committed sha256 ${committedArtifactSha256}, ` +
        `computed sha256 ${computedArtifactSha256}. The recompile is not reproducible.`,
    }
  }
  return { ok: true, message: `inner VK hash ${pinned} matches the committed pin` }
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Recompute the inner VK hash with the app's own aggregation prover (bb.js, recursive flavour). */
export async function computeInnerVk(artifactPath = INNER_ARTIFACT) {
  const { createAggregationProver, HONK_VK_FIELDS } = await import('../src/utils/zkProver.js')
  const raw = readFileSync(artifactPath)
  const innerCircuit = JSON.parse(raw.toString('utf8'))
  const prover = createAggregationProver({ innerCircuit, outerCircuit: null, threads: 1 })
  const { fields, hash } = await prover.innerVk()
  if (fields.length !== HONK_VK_FIELDS) {
    throw new Error(`expected ${HONK_VK_FIELDS} VK fields, got ${fields.length}`)
  }
  return { hash: hash.toLowerCase(), artifactSha256: sha256Hex(raw) }
}

function readPin(path = PIN_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function pinnedBbVersion() {
  const pins = JSON.parse(readFileSync(resolve(ROOT, 'crypto-pins.json'), 'utf8')).pins
  return pins.find((p) => p.name === '@aztec/bb.js')?.version ?? 'unknown'
}

async function main() {
  const write = process.argv.includes('--write')
  const pin = readPin()
  const computed = await computeInnerVk()

  if (write) {
    const next = {
      $comment:
        'ISP-051 / #938: inner responder_credential VK hash pinned as the recursive verifier constant. ' +
        'Regenerate only with scripts/check-recursive-verifier-vk.mjs --write after a reviewed circuit change.',
      circuit: 'responder_credential',
      innerVkHash: computed.hash,
      innerVkFields: 112,
      circuitArtifactSha256: computed.artifactSha256,
      pinnedWith: { nargo: '1.0.0-beta.9', bbJs: pinnedBbVersion() },
    }
    writeFileSync(PIN_PATH, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`pinned ${computed.hash} -> ${PIN_PATH}`)
    return 0
  }

  const result = compareInnerVkHash({
    committed: pin.innerVkHash,
    computed: computed.hash,
    committedArtifactSha256: pin.circuitArtifactSha256 ?? null,
    computedArtifactSha256: computed.artifactSha256,
  })
  console.log(result.message)
  return result.ok ? 0 : 1
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err)
      process.exit(2)
    },
  )
}
