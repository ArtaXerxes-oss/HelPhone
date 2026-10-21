import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useFeatureFlag } from '../lib/featureFlags.js'
import { passkeyManager } from '../lib/passkey.js'
import { useWallet } from '../contexts/WalletContext.js'
import { useLocationSearch } from '../hooks/useLocationSearch.js'
import {
  buildResponderKeyRecords,
  decryptEmergencyPayload,
  encryptEmergencyPayload,
  exportPrivateKeyJwk,
  exportPublicKeyHex,
  generateEncryptionKeyPair,
  importPrivateKeyJwk,
  MAX_PAYLOAD_PLAINTEXT_BYTES,
} from '../lib/crypto.js'
import { api } from '../services/api.js'

/** Where a responder's sealed private key is stashed, per Stellar address. */
const RESPONDER_KEY_PREFIX = 'hp_responder_e2ee_v1:'

interface ResponderKeyState {
  publicKey: string
  privateKey: CryptoKey
}

/**
 * Load (or create) this wallet's responder encryption key.
 *
 * The private half never leaves the browser: it is kept in `sessionStorage` and
 * re-imported on reload so a refresh does not mint a new key (which would
 * orphan every envelope already sealed for this responder). A production build
 * should move this into the encrypted `SecureStorage` (src/lib/secureStorage.ts);
 * sessionStorage is the safer default because it is wiped when the tab closes.
 */
async function loadOrCreateResponderKey(wallet: string): Promise<ResponderKeyState> {
  const storageKey = `${RESPONDER_KEY_PREFIX}${wallet}`
  const stored = sessionStorage.getItem(storageKey)
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as { jwk: JsonWebKey; publicKey: string }
      return {
        publicKey: parsed.publicKey,
        privateKey: await importPrivateKeyJwk(parsed.jwk),
      }
    } catch {
      // Corrupt entry — fall through and mint a fresh key.
      sessionStorage.removeItem(storageKey)
    }
  }
  const pair = await generateEncryptionKeyPair()
  const publicKey = await exportPublicKeyHex(pair.publicKey)
  const jwk = await exportPrivateKeyJwk(pair.privateKey)
  sessionStorage.setItem(storageKey, JSON.stringify({ jwk, publicKey }))
  // Publish the public half so requesters can seal for us. Failure here only
  // costs us dispatch offers; it must not block the page.
  void api.registerDispatchKey(wallet, publicKey)
  return { publicKey, privateKey: pair.privateKey }
}
import { emergencyAudioAlert } from '../lib/audioAlert.js'

export default function Help() {
  const passkeyAuthEnabled = useFeatureFlag('passkey_authentication')
  const encryptedDispatchEnabled = useFeatureFlag('encrypted_dispatch')
  const { walletState, connectWallet } = useWallet()
  const [statusMessage, setStatusMessage] = useState<string>('')
  const [passkeyVerified, setPasskeyVerified] = useState<boolean>(false)
  const [contact, setContact] = useState<string>('')
  const [medicalNotes, setMedicalNotes] = useState<string>('')
  const [recipientCount, setRecipientCount] = useState<number | null>(null)
  const [revealed, setRevealed] = useState<{ requestId: string; contact: string; medicalNotes: string } | null>(
    null
  )
  const [revealError, setRevealError] = useState<string>('')

  const {
    location,
    searchQuery,
    setSearchQuery,
    searchLoading,
    searchError,
    searchSuggestions,
    searchSuggestLoading,
    selectSearchSuggestion,
    handleSearchKeyDown,
  } = useLocationSearch({ mapboxToken: '' })
  const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false
  const hasOfflineMatch = searchSuggestions.some(
    (s: any) => s?.properties?.offline === true,
  )

  const handlePasskeyAuth = async () => {
    try {
      setStatusMessage('Authenticating with WebAuthn Passkey...')
      const credential = await passkeyManager.authenticatePasskey()

      if (credential) {
        const verification = await passkeyManager.verifyAssertion(credential)
        if (verification.verified) {
          setPasskeyVerified(true)
          setStatusMessage('✅ Passkey authenticated successfully! Emergency broadcast authorized.')
        } else {
          setStatusMessage(`❌ Passkey verification failed: ${verification.error}`)
        }
      }
    } catch (err: any) {
      setStatusMessage(`Passkey sign-in: ${err.message}`)
    }
  }

  /**
   * Seal the contact number and medical notes for the request plus every
   * registered responder, then hand the ciphertext to the relay.
   *
   * Nothing readable is produced here beyond the in-memory plaintext the user
   * just typed; the relay only ever sees the envelope.
   */
  const handleSealAndDispatch = useCallback(async () => {
    if (!walletState.address) {
      setRevealError('Connect your Stellar wallet first.')
      return
    }
    if (!contact.trim() && !medicalNotes.trim()) {
      setRevealError('Add a contact number or a medical note to seal.')
      return
    }
    setRevealError('')

    try {
      const own = await loadOrCreateResponderKey(walletState.address)
      const registry = await api.getDispatchRecipientKeys()
      const keys = registry.success && registry.keys?.length ? registry.keys : []

      // Always seal to ourselves too, so the requester can re-read what they
      // submitted. `buildResponderKeyRecords` drops duplicate public keys.
      const recipients = await buildResponderKeyRecords([
        { wallet: walletState.address, publicKey: own.publicKey },
        ...keys.map((k) => ({ wallet: k.wallet, publicKey: k.publicKey })),
      ])
      setRecipientCount(recipients.length)

      // The request id is not known until the on-chain submission lands, so
      // this demo seals against a client-side nonce and the real submission
      // re-seals with the ledger id (see src/lib/contract.ts#createRequest).
      const requestId = `local-${Date.now()}`
      const envelope = await encryptEmergencyPayload(
        { contact: contact.trim(), medicalNotes: medicalNotes.trim(), nickname: '' },
        recipients.map((r) => r.publicKey),
        requestId
      )
      const stored = await api.storeDispatchEnvelope(requestId, envelope)
      if (!stored.success) {
        setRevealError(`Relay refused the envelope: ${stored.error ?? 'unknown error'}`)
        return
      }

      // Prove the round trip locally: read back exactly what a responder will.
      const back = await decryptEmergencyPayload(envelope, own.privateKey, requestId)
      setRevealed({ requestId, contact: back.contact, medicalNotes: back.medicalNotes })
      setStatusMessage('🔒 Payload sealed end-to-end. Only your key and the responders’ can open it.')
    } catch (err: any) {
      setRevealError(err?.message || 'Could not seal the emergency payload.')
    }
  }, [walletState.address, contact, medicalNotes])

  /** Count the plaintext budget so the UI can warn before the seal throws. */
  const plaintextBytes = new TextEncoder().encode(
    JSON.stringify({ contact, medicalNotes, nickname: '' })
  ).length
  const overBudget = plaintextBytes > MAX_PAYLOAD_PLAINTEXT_BYTES
  // ISP-049: the first tap anywhere unlocks audio, so a later alert that has no
  // gesture of its own can sound instead of being silently blocked.
  useEffect(() => emergencyAudioAlert.armOnFirstGesture(), [])

  const handleTestSiren = async () => {
    try {
      const outcome = await emergencyAudioAlert.play()
      setStatusMessage(
        outcome === 'played'
          ? 'Emergency siren preview played.'
          : 'Your browser is blocking sound. Tap the page once, then try again; vibration was used instead.'
      )
    } catch (err: any) {
      setStatusMessage(err.message || 'Unable to play the emergency siren.')
    }
  }

  return (
    <div
      style={{
        background: '#1c2c24',
        color: '#ECE0CC',
        minHeight: '100vh',
        padding: 'clamp(1rem, 4vw, 2rem)',
        boxSizing: 'border-box',
        overflowX: 'hidden',
      }}
    >
      <header style={{ marginBottom: '2rem' }}>
        <Link to="/" style={{ color: '#FF7A6B', textDecoration: 'none', fontWeight: 'bold' }}>
          ← Back to HelPhone Home
        </Link>
        <h1 style={{ fontSize: 'clamp(1.5rem, 6vw, 2.5rem)', marginTop: '1rem' }}>
          Emergency Dispatch Request
        </h1>
      </header>

      <div
        style={{
          background: '#234B4E',
          padding: 'clamp(1.25rem, 5vw, 2rem)',
          borderRadius: '1rem',
          maxWidth: '600px',
          width: '100%',
          boxSizing: 'border-box',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
      >
        <h2>Submit Emergency Alert</h2>
        <p style={{ color: '#a2a586' }}>
          Broadcast encrypted location and incident report to nearby community responders.
        </p>
        <button
          type="button"
          onClick={handleTestSiren}
          aria-label="Play emergency siren preview"
          style={{
            background: '#FF7A6B',
            color: '#1c2c24',
            border: 'none',
            padding: '0.65rem 1rem',
            borderRadius: '0.5rem',
            cursor: 'pointer',
            fontWeight: 'bold',
            marginBottom: '1rem',
          }}
        >
          Test emergency siren
        </button>

        {/* Location search — hybrid Mapbox → offline geocoder (#518). Works with
            no access token and while offline, using the bundled city dataset. */}
        <div style={{ marginBottom: '1.5rem', position: 'relative' }}>
          <label
            htmlFor="emergency-location-search"
            style={{ display: 'block', marginBottom: '0.4rem', fontWeight: 'bold' }}
          >
            Your location (city)
          </label>
          <input
            id="emergency-location-search"
            type="text"
            role="combobox"
            aria-expanded={searchSuggestions.length > 0}
            aria-controls="emergency-location-suggestions"
            aria-autocomplete="list"
            placeholder={isOffline ? 'Search offline city list…' : 'Search city…'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            style={{
              width: '100%',
              padding: '0.75rem',
              borderRadius: '0.5rem',
              border: '1px solid rgba(255,255,255,0.25)',
              background: '#1c2c24',
              color: '#ECE0CC',
            }}
          />
          {isOffline && (
            <p style={{ fontSize: '0.8rem', color: '#FF7A6B', margin: '0.3rem 0 0' }}>
              Offline — using bundled city search.
            </p>
          )}
          {hasOfflineMatch && (
            <p style={{ fontSize: '0.8rem', color: '#a2a586', margin: '0.3rem 0 0' }}>
              Matched offline from the bundled dataset.
            </p>
          )}
          {searchError && (
            <p role="alert" style={{ fontSize: '0.85rem', color: '#FF7A6B', margin: '0.3rem 0 0' }}>
              {searchError}
            </p>
          )}
          {location && (
            <p style={{ fontSize: '0.85rem', color: '#3F8487', margin: '0.3rem 0 0' }}>
              Selected location: {location[0].toFixed(4)}, {location[1].toFixed(4)}
            </p>
          )}
          {searchSuggestions.length > 0 && (
            <ul
              id="emergency-location-suggestions"
              role="listbox"
              style={{
                position: 'absolute',
                zIndex: 5,
                left: 0,
                right: 0,
                top: '100%',
                listStyle: 'none',
                margin: '0.3rem 0 0',
                padding: '0.25rem 0',
                background: '#234B4E',
                borderRadius: '0.5rem',
                border: '1px solid rgba(255,255,255,0.2)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
              }}
            >
              {searchSuggestions.map((suggestion: any, index: number) => (
                <li key={suggestion.id ?? index}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => selectSearchSuggestion(suggestion)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '0.5rem 0.75rem',
                      background: 'transparent',
                      color: '#ECE0CC',
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                    }}
                  >
                    {suggestion.text}
                    <span style={{ color: '#a2a586', marginLeft: '0.5rem', fontSize: '0.8rem' }}>
                      {suggestion.place_name?.split(', ').slice(1).join(', ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {walletState.isConnected ? (
          <p style={{ color: '#7357FF' }}>Connected Wallet: {walletState.address}</p>
        ) : (
          <button
            onClick={() => connectWallet()}
            style={{
              background: '#7357FF',
              color: '#fff',
              border: 'none',
              padding: '0.75rem 1.5rem',
              borderRadius: '0.5rem',
              cursor: 'pointer',
              marginBottom: '1rem',
            }}
          >
            Connect Stellar Wallet
          </button>
        )}

        {passkeyAuthEnabled && (
          <div style={{ marginTop: '1.5rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '1.5rem' }}>
            <h3>Passkey Cryptographic Authorization</h3>
            <button
              onClick={handlePasskeyAuth}
              style={{
                background: '#FF7A6B',
                color: '#fff',
                border: 'none',
                padding: '0.75rem 1.5rem',
                borderRadius: '0.5rem',
                cursor: 'pointer',
                fontWeight: 'bold',
              }}
            >
              🔑 Authenticate Passkey (P-256)
            </button>
          </div>
        )}

        {encryptedDispatchEnabled && (
          <div style={{ marginTop: '1.5rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '1.5rem' }}>
            <h3>🔒 End-to-End Encrypted Details</h3>
            <p style={{ color: '#a2a586', fontSize: '0.9rem' }}>
              Your contact number and medical notes are sealed on this device with
              ECDH&nbsp;P-256 + AES-256-GCM. The ledger and our relay only ever store
              ciphertext, and the key never leaves your browser.
            </p>

            <label
              htmlFor="emergency-contact"
              style={{ display: 'block', margin: '0.75rem 0 0.3rem', fontWeight: 'bold', fontSize: '0.9rem' }}
            >
              Contact number or handle
            </label>
            <input
              id="emergency-contact"
              type="text"
              autoComplete="tel"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="+1 555 0100"
              style={{
                width: '100%',
                padding: '0.75rem',
                borderRadius: '0.5rem',
                border: '1px solid rgba(255,255,255,0.25)',
                background: '#1c2c24',
                color: '#ECE0CC',
              }}
            />

            <label
              htmlFor="emergency-medical-notes"
              style={{ display: 'block', margin: '0.75rem 0 0.3rem', fontWeight: 'bold', fontSize: '0.9rem' }}
            >
              Medical notes (allergies, medications, conditions)
            </label>
            <textarea
              id="emergency-medical-notes"
              rows={3}
              value={medicalNotes}
              onChange={(e) => setMedicalNotes(e.target.value)}
              placeholder="Carries an epinephrine auto-injector."
              aria-describedby="emergency-medical-notes-budget"
              style={{
                width: '100%',
                padding: '0.75rem',
                borderRadius: '0.5rem',
                border: '1px solid rgba(255,255,255,0.25)',
                background: '#1c2c24',
                color: '#ECE0CC',
                resize: 'vertical',
              }}
            />
            <p
              id="emergency-medical-notes-budget"
              style={{ fontSize: '0.78rem', color: overBudget ? '#FF7A6B' : '#a2a586', margin: '0.3rem 0 0' }}
            >
              {plaintextBytes} / {MAX_PAYLOAD_PLAINTEXT_BYTES} bytes before encryption.
              {overBudget ? ' Too large to seal — shorten the notes.' : ''}
            </p>

            <button
              onClick={handleSealAndDispatch}
              disabled={overBudget}
              style={{
                background: overBudget ? '#a2a586' : '#234B4E',
                color: '#ECE0CC',
                border: '1px solid rgba(255,255,255,0.25)',
                padding: '0.75rem 1.5rem',
                borderRadius: '0.5rem',
                cursor: overBudget ? 'not-allowed' : 'pointer',
                marginTop: '0.75rem',
                fontWeight: 'bold',
              }}
            >
              Seal &amp; dispatch encrypted
            </button>

            {recipientCount !== null && (
              <p style={{ fontSize: '0.82rem', color: '#3F8487', marginTop: '0.6rem' }}>
                Sealed for {recipientCount} key{recipientCount === 1 ? '' : 's'} (you plus every
                registered responder).
              </p>
            )}

            {revealError && (
              <p role="alert" style={{ fontSize: '0.85rem', color: '#FF7A6B', marginTop: '0.6rem' }}>
                {revealError}
              </p>
            )}

            {revealed && (
              <div
                style={{
                  marginTop: '0.9rem',
                  padding: '0.9rem',
                  background: '#1c2c24',
                  borderRadius: '0.5rem',
                  border: '1px solid rgba(115,87,255,0.5)',
                }}
              >
                <p style={{ fontSize: '0.85rem', margin: 0, color: '#a2a586' }}>
                  Decrypted locally with your responder key — this is exactly what an authorized
                  responder sees:
                </p>
                {revealed.contact && (
                  <p style={{ fontSize: '0.95rem', margin: '0.35rem 0 0' }}>📞 {revealed.contact}</p>
                )}
                {revealed.medicalNotes && (
                  <p style={{ fontSize: '0.95rem', margin: '0.35rem 0 0' }}>🩺 {revealed.medicalNotes}</p>
                )}
              </div>
            )}
          </div>
        )}

        {statusMessage && (
          <p style={{ marginTop: '1.5rem', padding: '1rem', background: '#1c2c24', borderRadius: '0.5rem' }}>
            {statusMessage}
          </p>
        )}
      </div>
    </div>
  )
}
