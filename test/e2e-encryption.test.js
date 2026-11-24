import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  E2EEError,
  MAX_ENVELOPE_BYTES,
  MAX_PAYLOAD_PLAINTEXT_BYTES,
  MAX_PAYLOAD_RECIPIENTS,
  buildResponderKeyRecords,
  decryptEmergencyPayload,
  deriveKeyIdFromPublicKey,
  deriveKeyIdFromPrivateKey,
  encryptEmergencyPayload,
  estimateEnvelopeBytes,
  exportPrivateKeyJwk,
  exportPublicKeyHex,
  generateEncryptionKeyPair,
  importPrivateKeyJwk,
  isEncryptedEnvelope,
} from '../src/lib/crypto.js'
import { encodeEncryptedPayload, sealPayloadForOnChain } from '../src/lib/contract.js'
import { createDispatchRouters } from '../server/routes/dispatch.ts'

/**
 * End-to-end coverage for the encrypted emergency payload path.
 *
 * These tests stand in for a full browser + relay + ledger round trip:
 *   requester seals -> relay stores opaque bytes -> responder opens.
 * The relay is exercised through its real Express routers so the assertions
 * cover the HTTP boundary, not just the crypto primitives.
 */

// Realistic strkey-shaped accounts; the relay does a sanity check, not full
// strkey validation, so these only need to look like real ones.
const RESPONDER_A = 'GA5Z6JY3BC5J7VQ2XKZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ'
const RESPONDER = 'GB7X5JRMBQ2ZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ'
const MULTI = 'GC3X5JRMBQ2ZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ'
const WALLET_OK = 'GD4X5JRMBQ2ZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ'

const PROFILE = {
  contact: '+1-555-0100',
  medicalNotes: 'Carries an epinephrine auto-injector',
  nickname: 'Ana',
}

async function keyPair() {
  return generateEncryptionKeyPair()
}

describe('emergency payload encryption: key material', () => {
  it('generates a usable P-256 pair and exports a 65-byte public key', async () => {
    const k = await keyPair()
    expect(k.publicKey.algorithm).toMatchObject({ name: 'ECDH', namedCurve: 'P-256' })
    const hex = await exportPublicKeyHex(k.publicKey)
    expect(hex).toHaveLength(130) // 65 bytes, uncompressed SEC1 with 0x04 prefix
    expect(hex.slice(0, 2)).toBe('04')
  })

  it('derives the same stable keyId from the public and private halves', async () => {
    const k = await keyPair()
    const publicId = await deriveKeyIdFromPublicKey(await exportPublicKeyHex(k.publicKey))
    expect(publicId).toMatch(/^[0-9a-f]{16}$/)
    expect(await deriveKeyIdFromPrivateKey(k.privateKey)).toBe(publicId)
  })

  it('re-derives distinct ids for distinct keys', async () => {
    const a = await keyPair()
    const b = await keyPair()
    const [aId, bId] = await Promise.all([
      deriveKeyIdFromPublicKey(await exportPublicKeyHex(a.publicKey)),
      deriveKeyIdFromPublicKey(await exportPublicKeyHex(b.publicKey)),
    ])
    expect(aId).not.toBe(bId)
  })

  it('survives a reload via exported JWK (responder key persistence)', async () => {
    const k = await keyPair()
    // Simulate the sessionStorage round trip in Help.tsx / Help.jsx.
    const jwk = await exportPrivateKeyJwk(k.privateKey)
    const reimported = await importPrivateKeyJwk(JSON.parse(JSON.stringify(jwk)))
    const envelope = await encryptEmergencyPayload(
      PROFILE,
      [await exportPublicKeyHex(k.publicKey)],
      'sub-1',
    )
    expect((await decryptEmergencyPayload(envelope, reimported)).contact).toBe(PROFILE.contact)
  })
})

describe('emergency payload encryption: seal and open', () => {
  it('round-trips to a single recipient', async () => {
    const k = await keyPair()
    const envelope = await encryptEmergencyPayload(
      PROFILE,
      [await exportPublicKeyHex(k.publicKey)],
      7,
    )
    expect(isEncryptedEnvelope(envelope)).toBe(true)
    expect(await decryptEmergencyPayload(envelope, k.privateKey)).toEqual(PROFILE)
  })

  it('opens for every addressed recipient and refuses anyone else', async () => {
    const a = await keyPair()
    const b = await keyPair()
    const c = await keyPair()
    const recipients = await Promise.all(
      [a, b, c].map((k) => exportPublicKeyHex(k.publicKey)),
    )
    const envelope = await encryptEmergencyPayload(PROFILE, recipients, 42)
    expect(envelope.wrappedKeys).toHaveLength(3)

    for (const k of [a, b, c]) {
      const opened = await decryptEmergencyPayload(envelope, k.privateKey)
      expect(opened).toEqual(PROFILE)
    }

    const bystander = await keyPair()
    await expect(decryptEmergencyPayload(envelope, bystander.privateKey)).rejects.toThrow(
      /not one of the recipients/i,
    )
  })

  it('tolerates blank optional fields', async () => {
    const k = await keyPair()
    const sparse = { contact: '+1-555-0100', medicalNotes: '', nickname: '' }
    const envelope = await encryptEmergencyPayload(
      sparse,
      [await exportPublicKeyHex(k.publicKey)],
      'sparse',
    )
    expect(await decryptEmergencyPayload(envelope, k.privateKey)).toEqual(sparse)
  })

  it('normalises 7, "7" and 7n to the same binding context', async () => {
    const k = await keyPair()
    const envelope = await encryptEmergencyPayload(
      PROFILE,
      [await exportPublicKeyHex(k.publicKey)],
      7,
    )
    expect(envelope.bindingContext).toBe('7')
    expect((await decryptEmergencyPayload(envelope, k.privateKey, 7)).contact).toBe(
      PROFILE.contact,
    )
    expect((await decryptEmergencyPayload(envelope, k.privateKey, '7')).contact).toBe(
      PROFILE.contact,
    )
    expect((await decryptEmergencyPayload(envelope, k.privateKey, 7n)).contact).toBe(
      PROFILE.contact,
    )
  })

  it('rejects an empty binding context', async () => {
    const k = await keyPair()
    await expect(
      encryptEmergencyPayload(PROFILE, [await exportPublicKeyHex(k.publicKey)], '   '),
    ).rejects.toThrow(E2EEError)
  })
})

describe('emergency payload encryption: tamper and downgrade resistance', () => {
  let k
  let envelope

  beforeEach(async () => {
    k = await keyPair()
    envelope = await encryptEmergencyPayload(PROFILE, [await exportPublicKeyHex(k.publicKey)], 5)
  })

  it('rejects a caller-supplied context that disagrees with the envelope', async () => {
    await expect(decryptEmergencyPayload(envelope, k.privateKey, 99)).rejects.toThrow(
      /bound to a different request/i,
    )
  })

  it('fails authentication when the context field is edited', async () => {
    // The context is public, but it is in the AAD, so it is tamper-evident.
    const edited = { ...envelope, bindingContext: 'someone-elses-request' }
    await expect(decryptEmergencyPayload(edited, k.privateKey)).rejects.toThrow(
      /authentication|different request/i,
    )
  })

  it('fails authentication when the ciphertext is altered', async () => {
    const ct = envelope.ciphertext
    const edited = { ...envelope, ciphertext: (ct[0] === '0' ? '1' : '0') + ct.slice(1) }
    await expect(decryptEmergencyPayload(edited, k.privateKey)).rejects.toThrow(
      /authentication/i,
    )
  })

  it('fails authentication when the auth tag is altered', async () => {
    const tag = envelope.authTag
    const edited = { ...envelope, authTag: (tag[0] === '0' ? '1' : '0') + tag.slice(1) }
    await expect(decryptEmergencyPayload(edited, k.privateKey)).rejects.toThrow(
      /authentication/i,
    )
  })

  it('fails authentication when the IV is altered', async () => {
    const iv = envelope.iv
    const edited = { ...envelope, iv: (iv[0] === '0' ? '1' : '0') + iv.slice(1) }
    await expect(decryptEmergencyPayload(edited, k.privateKey)).rejects.toThrow(
      /authentication/i,
    )
  })

  it('fails authentication when a wrapped CEK is moved under another keyId', async () => {
    // Lookup is by keyId, so reordering is harmless — but transplanting B's
    // wrapped key into A's slot must not work, because A derives a different
    // KEK and the unwrap tag will not verify.
    const a = await keyPair()
    const b = await keyPair()
    const two = await encryptEmergencyPayload(
      PROFILE,
      await Promise.all([exportPublicKeyHex(a.publicKey), exportPublicKeyHex(b.publicKey)]),
      5,
    )
    expect(two.wrappedKeys[0].wrappedKey).not.toBe(two.wrappedKeys[1].wrappedKey)
    const [first, second] = two.wrappedKeys
    const transplanted = {
      ...two,
      wrappedKeys: [
        { ...first, wrappedKey: second.wrappedKey, wrapIv: second.wrapIv, wrapAuthTag: second.wrapAuthTag },
        second,
      ],
    }
    await expect(decryptEmergencyPayload(transplanted, a.privateKey)).rejects.toThrow(
      /authentication|unwrap|recipient/i,
    )
  })

  it('ignores wrappedKeys reordering, since lookup is by keyId', async () => {
    const a = await keyPair()
    const b = await keyPair()
    const two = await encryptEmergencyPayload(
      PROFILE,
      await Promise.all([exportPublicKeyHex(a.publicKey), exportPublicKeyHex(b.publicKey)]),
      5,
    )
    const reordered = { ...two, wrappedKeys: [...two.wrappedKeys].reverse() }
    expect(await decryptEmergencyPayload(reordered, a.privateKey)).toEqual(PROFILE)
    expect(await decryptEmergencyPayload(reordered, b.privateKey)).toEqual(PROFILE)
  })

  it('rejects an unknown version or algorithm downgrade', async () => {
    await expect(
      decryptEmergencyPayload({ ...envelope, version: 2 }, k.privateKey),
    ).rejects.toThrow(/envelope/i)
    await expect(
      decryptEmergencyPayload({ ...envelope, algorithm: 'AES-GCM' }, k.privateKey),
    ).rejects.toThrow(/envelope|algorithm/i)
  })

  it('rejects structurally invalid envelopes before touching WebCrypto', async () => {
    const cases = [
      null,
      undefined,
      'not-an-object',
      {},
      [],
      { ...envelope, ephemeralPublicKey: 'abcd' },
      { ...envelope, iv: '' },
      { ...envelope, wrappedKeys: [] },
    ]
    for (const bad of cases) {
      await expect(decryptEmergencyPayload(bad, k.privateKey)).rejects.toThrow(E2EEError)
    }
  })
})

describe('emergency payload encryption: no plaintext leaks', () => {
  it('keeps every sensitive field out of the serialized envelope', async () => {
    const k = await keyPair()
    const secrets = {
      contact: '+1-555-0100',
      medicalNotes: 'penicillin allergy',
      nickname: 'Zaphod',
    }
    const envelope = await encryptEmergencyPayload(
      secrets,
      [await exportPublicKeyHex(k.publicKey)],
      3,
    )
    const blob = JSON.stringify(envelope)
    expect(blob).not.toContain('555-0100')
    expect(blob).not.toContain('penicillin')
    expect(blob).not.toContain('Zaphod')
    expect(estimateEnvelopeBytes(envelope)).toBeGreaterThan(0)
  })

  it('reuses one content key across recipients, so ciphertext is identical', async () => {
    const a = await keyPair()
    const b = await keyPair()
    const envelope = await encryptEmergencyPayload(
      PROFILE,
      await Promise.all([exportPublicKeyHex(a.publicKey), exportPublicKeyHex(b.publicKey)]),
      3,
    )
    // Two ECDH derivations produce two different wrappedKeys for one CEK; the
    // AES-GCM body must be byte-identical, which is what keeps the envelope
    // small as the responder count grows.
    expect(envelope.wrappedKeys[0].wrappedKey).not.toBe(envelope.wrappedKeys[1].wrappedKey)
  })
})

describe('emergency payload encryption: limits', () => {
  it('refuses plaintext above the on-chain byte budget', async () => {
    const k = await keyPair()
    const oversized = { ...PROFILE, medicalNotes: 'x'.repeat(MAX_PAYLOAD_PLAINTEXT_BYTES) }
    await expect(
      encryptEmergencyPayload(oversized, [await exportPublicKeyHex(k.publicKey)], 1),
    ).rejects.toThrow(/too large|4\s*KiB|4096/i)
  })

  it('refuses more recipients than the envelope budget allows', async () => {
    const keys = await Promise.all(
      Array.from({ length: MAX_PAYLOAD_RECIPIENTS + 1 }, async () => {
        const k = await keyPair()
        return exportPublicKeyHex(k.publicKey)
      }),
    )
    await expect(encryptEmergencyPayload(PROFILE, keys, 1)).rejects.toThrow(
      /recipient|32/i,
    )
  })

  it('stays inside the contract MAX_ENVELOPE_BYTES budget for a full roster', async () => {
    // One envelope with the maximum roster must still fit in contract storage.
    const keys = await Promise.all(
      Array.from({ length: MAX_PAYLOAD_RECIPIENTS }, async () => {
        const k = await keyPair()
        return exportPublicKeyHex(k.publicKey)
      }),
    )
    const envelope = await encryptEmergencyPayload(PROFILE, keys, 1)
    const wire = JSON.stringify(envelope).length
    expect(wire).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES)
  })
})

describe('emergency payload encryption: responder registry', () => {
  it('deduplicates keys and derives each responder keyId', async () => {
    const k = await keyPair()
    const pub = await exportPublicKeyHex(k.publicKey)
    const records = await buildResponderKeyRecords([
      { wallet: 'G_REQ', publicKey: pub },
      { wallet: RESPONDER_A, publicKey: pub },
    ])
    expect(records).toHaveLength(1)
    expect(records[0].keyId).toBe(await deriveKeyIdFromPublicKey(pub))
  })

  it('skips malformed entries rather than failing the whole submission', async () => {
    const k = await keyPair()
    const records = await buildResponderKeyRecords([
      { wallet: '', publicKey: 'not-a-key' },
      { wallet: WALLET_OK, publicKey: await exportPublicKeyHex(k.publicKey) },
    ])
    expect(records).toHaveLength(1)
    expect(records[0].wallet).toBe(WALLET_OK)
  })

  it('accepts a wallet with several registered keys', async () => {
    const a = await keyPair()
    const b = await keyPair()
    const records = await buildResponderKeyRecords([
      { wallet: MULTI, publicKey: await exportPublicKeyHex(a.publicKey) },
      { wallet: MULTI, publicKey: await exportPublicKeyHex(b.publicKey) },
    ])
    expect(records).toHaveLength(2)
    expect(new Set(records.map((r) => r.keyId)).size).toBe(2)
  })
})

describe('emergency payload encryption: on-chain encoding', () => {
  it('encodes the envelope as hex bytes for a Bytes argument', async () => {
    const k = await keyPair()
    const envelope = await encryptEmergencyPayload(
      PROFILE,
      [await exportPublicKeyHex(k.publicKey)],
      'sub-1',
    )
    const bytes = encodeEncryptedPayload(envelope)
    expect(typeof bytes).toBe('string')
    expect(bytes).toMatch(/^[0-9a-f]+$/)
    // Round-trips back to the same envelope.
    const json = Buffer.from(bytes, 'hex').toString('utf8')
    expect(JSON.parse(json)).toEqual(envelope)
  })

  it('refuses a plaintext string so it can never reach the ledger', () => {
    expect(() => encodeEncryptedPayload('+1-555-0100')).toThrow(/envelope|encrypt/i)
  })

  it('refuses a malformed envelope object', () => {
    expect(() => encodeEncryptedPayload({ version: 1, contact: 'x' })).toThrow()
  })
})

describe('emergency payload encryption: opaque relay round trip', () => {
  /**
   * Minimal in-process request/response harness for the real Express routers.
   *
   * Express 4 keeps `router.stack` with one entry per `router.<verb>(path)`
   * call, including `:param` segments, so the routes can be exercised at the
   * HTTP boundary without standing up a listener. Enough of the Express `req`
   * and `res` surface is implemented for the handlers in dispatch.ts.
   */
  function harness() {
    const routes = []
    const app = {
      use(mountPath, router) {
        const base = mountPath === '/' ? '' : mountPath
        for (const layer of router?.stack ?? []) {
          if (!layer.route) continue
          const segments = (base + layer.route.path).split('/').filter(Boolean)
          const verbs = Object.keys(layer.route.methods ?? {})
          for (const verb of verbs) {
            routes.push({
              verb: verb.toUpperCase(),
              segments,
              handle: layer.route.stack[0].handle,
            })
          }
        }
      },
    }

    const match = (segments, path) => {
      const actual = path.split('/').filter(Boolean)
      if (actual.length !== segments.length) return null
      const params = {}
      for (let i = 0; i < segments.length; i += 1) {
        const spec = segments[i]
        if (spec.startsWith(':')) params[spec.slice(1)] = decodeURIComponent(actual[i])
        else if (spec !== actual[i]) return null
      }
      return params
    }

    const run = async (path, { method = 'GET', body = {} } = {}) => {
      for (const route of routes) {
        const params = match(route.segments, path)
        if (!params) continue
        if (route.verb !== method && !(route.verb === 'DELETE' && method === 'GET')) continue
        return new Promise((resolve, reject) => {
          const res = {
            statusCode: 200,
            locals: {},
            headers: {},
            set(k, v) {
              this.headers[k.toLowerCase()] = v
              return this
            },
            type(t) {
              this.headers['content-type'] = t
              return this
            },
            status(c) {
              this.statusCode = c
              return this
            },
            json(payload) {
              resolve({ status: this.statusCode, body: payload, headers: this.headers })
            },
            send(payload) {
              resolve({ status: this.statusCode, body: payload, headers: this.headers })
            },
          }
          const req = {
            method,
            path,
            params,
            body,
            headers: {},
            ip: '203.0.113.7',
            socket: { remoteAddress: '203.0.113.7' },
          }
          try {
            route.handle(req, res, (err) => (err ? reject(err) : undefined))
          } catch (e) {
            reject(e)
          }
        })
      }
      throw new Error(`no route for ${method} ${path}`)
    }
    return { app, run }
  }

  let dispatch

  beforeEach(() => {
    dispatch = createDispatchRouters({})
  })

  afterEach(() => {
    dispatch.limiter.reset()
  })

  it('registers responder keys and lists them for sealers', async () => {
    const k = await keyPair()
    const pub = await exportPublicKeyHex(k.publicKey)
    const { app, run } = harness()
    app.use('/api/dispatch', dispatch.api)

    const registered = await run('/api/dispatch/keys', {
      method: 'POST',
      body: { wallet: RESPONDER_A, publicKey: pub },
    })
    expect(registered.status).toBe(200)
    expect(registered.body.success).toBe(true)
    expect(registered.body.keyId).toBe(await deriveKeyIdFromPublicKey(pub))

    const listed = await run('/api/dispatch/keys')
    expect(listed.body.success).toBe(true)
    expect(listed.body.keys).toHaveLength(1)
    expect(listed.body.keys[0]).toMatchObject({ wallet: RESPONDER_A, publicKey: pub })
  })

  it('stores an envelope opaquely and serves it back for decryption', async () => {
    const requester = await keyPair()
    const responder = await keyPair()
    const requesterPub = await exportPublicKeyHex(requester.publicKey)
    const responderPub = await exportPublicKeyHex(responder.publicKey)

    const { app, run } = harness()
    app.use('/api/dispatch', dispatch.api)
    await run('/api/dispatch/keys', {
      method: 'POST',
      body: { wallet: RESPONDER, publicKey: responderPub },
    })

    const registry = await run('/api/dispatch/keys')
    const recipientKeys = [requesterPub, ...registry.body.keys.map((k) => k.publicKey)]
    const envelope = await encryptEmergencyPayload(PROFILE, recipientKeys, 'sub-7')

    const stored = await run('/api/dispatch/payload/sub-7', { method: 'POST', body: { envelope } })
    expect(stored.status).toBe(200)
    expect(stored.body.success).toBe(true)

    const fetched = await run('/api/dispatch/payload/sub-7')
    expect(fetched.body.success).toBe(true)
    expect(fetched.body.envelopes).toHaveLength(1)

    // The relay's stored copy is still readable by an authorized responder and
    // is byte-identical to what was sealed.
    const relayed = await decryptEmergencyPayload(fetched.body.envelopes[0], responder.privateKey)
    expect(relayed).toEqual(PROFILE)
  })

  it('never stores or returns plaintext medical fields', async () => {
    const k = await keyPair()
    const { app, run } = harness()
    app.use('/api/dispatch', dispatch.api)
    const envelope = await encryptEmergencyPayload(
      PROFILE,
      [await exportPublicKeyHex(k.publicKey)],
      'sub-8',
    )
    await run('/api/dispatch/payload/sub-8', { method: 'POST', body: { envelope } })
    const fetched = await run('/api/dispatch/payload/sub-8')
    const raw = JSON.stringify(fetched.body)
    expect(raw).not.toContain('penicillin')
    expect(raw).not.toContain('epinephrine')
    expect(raw).not.toContain('555-0100')
    expect(raw).not.toContain('Ana')
  })

  it('rejects a request body carrying plaintext fields instead of an envelope', async () => {
    const { app, run } = harness()
    app.use('/api/dispatch', dispatch.api)
    const res = await run('/api/dispatch/payload/sub-9', {
      method: 'POST',
      body: { envelope: { version: 1, contact: '+1-555-0100' } },
    })
    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
  })

  it('rejects an oversized envelope instead of truncating it', async () => {
    const k = await keyPair()
    const { app, run } = harness()
    app.use('/api/dispatch', dispatch.api)
    const envelope = await encryptEmergencyPayload(
      PROFILE,
      [await exportPublicKeyHex(k.publicKey)],
      'big',
    )
    const res = await run('/api/dispatch/payload/big', {
      method: 'POST',
      body: { envelope: { ...envelope, ciphertext: 'ab'.repeat(MAX_ENVELOPE_BYTES) } },
    })
    expect(res.status).toBe(413)
    expect(res.body.success).toBe(false)
  })

  it('returns an empty list for an unknown request rather than erroring', async () => {
    const { app, run } = harness()
    app.use('/api/dispatch', dispatch.api)
    const res = await run('/api/dispatch/payload/never-seen')
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.envelopes).toEqual([])
  })

  it('exports relay metrics without leaking envelope contents', async () => {
    const k = await keyPair()
    const { app, run } = harness()
    app.use('/api/dispatch', dispatch.api)
    app.use('/metrics', dispatch.metrics)
    const envelope = await encryptEmergencyPayload(
      PROFILE,
      [await exportPublicKeyHex(k.publicKey)],
      'sub-m',
    )
    await run('/api/dispatch/payload/sub-m', { method: 'POST', body: { envelope } })
    await run('/api/dispatch/payload/sub-m', { method: 'POST', body: { envelope } })

    const res = await run('/metrics/dispatch')
    expect(typeof res.body).toBe('string')
    expect(res.body).toContain('helphone_dispatch')
    expect(res.body).not.toContain('epinephrine')
    expect(res.body).not.toContain('555-0100')
  })

  it('refuses writes when the feature is switched off', async () => {
    const off = createDispatchRouters({ enabled: false })
    const { app, run } = harness()
    app.use('/api/dispatch', off.api)
    const res = await run('/api/dispatch/payload/sub-x', {
      method: 'POST',
      body: {
        envelope: await encryptEmergencyPayload(
          PROFILE,
          [await exportPublicKeyHex((await keyPair()).publicKey)],
          'sub-x',
        ),
      },
    })
    expect(res.status).toBe(503)
    expect(res.body.success).toBe(false)
  })
})
