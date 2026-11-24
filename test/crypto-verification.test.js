import { describe, it, expect } from 'vitest'
import {
  generateEd25519Keypair,
  signEd25519Message,
  verifyEd25519Signature,
  verifyWebAuthnSignature,
  encryptAESGCM,
  decryptAESGCM,
} from '../src/lib/crypto.js'
import { authMiddleware } from '../server/middleware/auth.js'

describe('Cross-Layer Signature Verification Testing Suite', () => {
  describe('Ed25519 Signature Verification Pipeline', () => {
    it('should generate keypair, sign message, and verify signature successfully', () => {
      const { publicKey, secretKey } = generateEd25519Keypair()
      const message = 'HELPHONE_EMERGENCY_DISPATCH_ALERT_911'

      const signatureHex = signEd25519Message(message, secretKey)
      expect(signatureHex).toBeDefined()
      expect(signatureHex.length).toBe(128) // 64-byte hex signature

      const isValid = verifyEd25519Signature(message, signatureHex, publicKey)
      expect(isValid).toBe(true)
    })

    it('Negative Boundary Test: reject tampered message payload', () => {
      const { publicKey, secretKey } = generateEd25519Keypair()
      const originalMessage = 'HELPHONE_EMERGENCY_DISPATCH_ALERT_911'
      const tamperedMessage = 'HELPHONE_EMERGENCY_DISPATCH_ALERT_912'

      const signatureHex = signEd25519Message(originalMessage, secretKey)
      const isValid = verifyEd25519Signature(tamperedMessage, signatureHex, publicKey)

      expect(isValid).toBe(false)
    })

    it('Negative Boundary Test: reject invalid signature bytes or wrong public key', () => {
      const { publicKey } = generateEd25519Keypair()
      const wrongKeyPair = generateEd25519Keypair()
      const message = 'AUTHENTICATION_NONCE_12345'

      const validSigOnWrongKey = signEd25519Message(message, wrongKeyPair.secretKey)
      const isValid = verifyEd25519Signature(message, validSigOnWrongKey, publicKey)

      expect(isValid).toBe(false)
    })
  })

  describe('WebAuthn P-256 (ECDSA SHA-256) Signature Verification', () => {
    it('should verify valid WebAuthn assertion payload and challenge', async () => {
      const expectedChallenge = 'aW5wdXRfY2hhbGxlbmdlX2Jhc2U2NA=='
      const clientDataJSON = JSON.stringify({
        type: 'webauthn.get',
        challenge: expectedChallenge,
        origin: 'https://helphone.com',
      })
      const authenticatorDataHex = '499602d28018500e3441b0057e59d08d2b254a24a7'
      const signatureHex = '3044022011223344556677889900aabbccddeeff022011223344556677889900aabbccddeeff'

      const result = await verifyWebAuthnSignature(
        clientDataJSON,
        authenticatorDataHex,
        signatureHex,
        expectedChallenge
      )

      expect(result.verified).toBe(true)
    })

    it('Negative Boundary Test: reject challenge mismatch in clientDataJSON', async () => {
      const clientDataJSON = JSON.stringify({
        type: 'webauthn.get',
        challenge: 'WRONG_CHALLENGE',
        origin: 'https://helphone.com',
      })

      const result = await verifyWebAuthnSignature(
        clientDataJSON,
        '499602d28018500e3441',
        '30440220112233',
        'EXPECTED_CHALLENGE'
      )

      expect(result.verified).toBe(false)
      expect(result.error).toContain('Challenge mismatch')
    })
  })

  describe('AES-256-GCM Encryption & Decryption Pipeline', () => {
    const passcode = 'SuperSecretEncryptionKey12345678901234567890!'

    it('should encrypt and decrypt plaintext accurately', async () => {
      const plaintext = 'HelPhone Responder Secret Seed Key: S...'
      const encrypted = await encryptAESGCM(plaintext, passcode)

      expect(encrypted.ciphertext).toBeDefined()
      expect(encrypted.iv).toBeDefined()
      expect(encrypted.authTag).toBeDefined()
      expect(encrypted.algorithm).toBe('AES-GCM')

      const decrypted = await decryptAESGCM(encrypted, passcode)
      expect(decrypted).toBe(plaintext)
    })

    it('Negative Boundary Test: reject corrupted ciphertext or wrong passcode', async () => {
      const plaintext = 'HelPhone Responder Secret'
      const encrypted = await encryptAESGCM(plaintext, passcode)

      const wrongPasscode = 'WrongPasscodeKey12345678901234567890!'
      await expect(decryptAESGCM(encrypted, wrongPasscode)).rejects.toThrow()
    })
  })

  describe('Server Express Cryptographic Auth Middleware', () => {
    it('Negative Boundary Test: reject request with missing headers', async () => {
      const req = { header: () => null }
      let resStatus = 0
      let resJson = null

      const res = {
        status: (code) => {
          resStatus = code
          return res
        },
        json: (data) => {
          resJson = data
          return res
        },
      }

      await authMiddleware(req, res, () => {})

      expect(resStatus).toBe(401)
      expect(resJson.error).toContain('Missing required cryptographic authentication headers')
    })

    it('Negative Boundary Test: reject expired timestamp', async () => {
      const expiredTimestamp = (Date.now() - 10 * 60 * 1000).toString() // 10 minutes ago
      const req = {
        header: (name) => {
          if (name === 'X-Signature') return 'sig'
          if (name === 'X-Public-Key') return 'pub'
          if (name === 'X-Timestamp') return expiredTimestamp
          return null
        },
      }

      let resStatus = 0
      let resJson = null

      const res = {
        status: (code) => {
          resStatus = code
          return res
        },
        json: (data) => {
          resJson = data
          return res
        },
      }

      await authMiddleware(req, res, () => {})

      expect(resStatus).toBe(401)
      expect(resJson.error).toContain('timestamp expired')
    })
  })
})
