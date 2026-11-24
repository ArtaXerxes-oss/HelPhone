import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import crypto from 'crypto'
import type { PasskeyCredential, WebAuthnVerificationResult } from '../types/index.js'
import { signEd25519Message, verifyEd25519Signature, isIdentityRevoked } from './crypto.ts'
import type { TrustBundle } from './crypto.ts'

type ServerResponse = { options: Record<string, unknown>; error?: string }

async function request(path: string, body: unknown) {
  const response = await fetch(`/api/auth/passkey/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || `Passkey request failed (${response.status})`)
  return result
}

export class PasskeyManager {
  public isWebAuthnSupported(): boolean {
    return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined' && typeof navigator.credentials !== 'undefined'
  }

  public async registerPasskey(username: string, displayName: string): Promise<PasskeyCredential | null> {
    if (!this.isWebAuthnSupported()) throw new Error('WebAuthn Passkeys are not supported in this browser')
    const { options } = await request('register/options', { username, displayName }) as ServerResponse
    const response = await startRegistration({ optionsJSON: options as never })
    const result = await request('register/verify', { challenge: options.challenge, response })
    if (result.sessionToken) sessionStorage.setItem('helphone-passkey-session', result.sessionToken)
    return { id: response.id, rawId: response.rawId, type: 'public-key', response: response.response, challenge: String(options.challenge) } as unknown as PasskeyCredential
  }

  public async authenticatePasskey(_clientChallenge?: string, username?: string): Promise<PasskeyCredential | null> {
    if (!this.isWebAuthnSupported()) throw new Error('WebAuthn Passkeys are not supported in this browser')
    const { options } = await request('login/options', { username }) as ServerResponse
    const response = await startAuthentication({ optionsJSON: options as never })
    return { id: response.id, rawId: response.rawId, type: 'public-key', response: response.response, challenge: String(options.challenge) } as unknown as PasskeyCredential
  }

  public async verifyAssertion(credential: PasskeyCredential): Promise<WebAuthnVerificationResult> {
    const result = await request('login/verify', { challenge: credential.challenge, response: credential })
    if (result.sessionToken) sessionStorage.setItem('helphone-passkey-session', result.sessionToken)
    return { verified: result.verified === true, userHandle: result.userHandle }
  }
}

export const passkeyManager = new PasskeyManager()

// ── Cross-Domain Identity Bridging (ISP-144) ──────────────────────────────

export interface ScopedCredentialPresentation {
  credentialId: string
  originInstance: string
  targetDomain: string
  presentationNonce: string
  issuedAt: number
  expiresAt: number
  nullifierHash: string
  attestationSignature: string
  signingPublicKey: string
}

export function presentCrossDomainCredential(params: {
  credentialId: string
  originInstance: string
  targetDomain: string
  nullifier: string
  secretKey: string
  publicKey: string
  ttlMs?: number
}): ScopedCredentialPresentation {
  const now = Date.now()
  const ttl = params.ttlMs ?? 600_000 // 10 minutes
  const nonce = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2)

  // Domain-separated nullifier hash: prevents double-spending / Sybil linkage across domains
  const nullifierHash = crypto
    .createHash('sha256')
    .update(`${params.nullifier}:${params.targetDomain}`)
    .digest('hex')

  const presentationData = {
    credentialId: params.credentialId,
    originInstance: params.originInstance,
    targetDomain: params.targetDomain,
    presentationNonce: nonce,
    issuedAt: now,
    expiresAt: now + ttl,
    nullifierHash,
  }

  // Ed25519 or HMAC signature of canonical payload
  const message = JSON.stringify(presentationData)
  const attestationSignature = signEd25519Message(message, params.secretKey)

  return {
    ...presentationData,
    attestationSignature,
    signingPublicKey: params.publicKey,
  }
}

export function verifyCrossDomainPresentation(
  presentation: ScopedCredentialPresentation,
  expectedTargetDomain: string,
  peerTrustBundle: TrustBundle,
  now = Date.now()
): { verified: boolean; error?: string } {
  if (!presentation || typeof presentation !== 'object') {
    return { verified: false, error: 'Malformed presentation' }
  }

  if (presentation.targetDomain !== expectedTargetDomain) {
    return {
      verified: false,
      error: `Domain mismatch: presentation is scoped for ${presentation.targetDomain}, expected ${expectedTargetDomain}`,
    }
  }

  if (presentation.originInstance !== peerTrustBundle.instanceId) {
    return {
      verified: false,
      error: `Origin instance mismatch: presentation=${presentation.originInstance}, bundle=${peerTrustBundle.instanceId}`,
    }
  }

  if (now > presentation.expiresAt) {
    return { verified: false, error: 'Cross-domain credential presentation has expired' }
  }

  // Check revocation in peer trust bundle
  if (isIdentityRevoked(presentation.credentialId, peerTrustBundle) ||
      isIdentityRevoked(presentation.nullifierHash, peerTrustBundle)) {
    return { verified: false, error: 'Identity has been revoked by peer instance' }
  }

  const presentationData = {
    credentialId: presentation.credentialId,
    originInstance: presentation.originInstance,
    targetDomain: presentation.targetDomain,
    presentationNonce: presentation.presentationNonce,
    issuedAt: presentation.issuedAt,
    expiresAt: presentation.expiresAt,
    nullifierHash: presentation.nullifierHash,
  }

  const message = JSON.stringify(presentationData)
  const isSigValid = verifyEd25519Signature(
    message,
    presentation.attestationSignature,
    presentation.signingPublicKey
  )

  if (!isSigValid) {
    return { verified: false, error: 'Invalid attestation signature on presentation' }
  }

  return { verified: true }
}

