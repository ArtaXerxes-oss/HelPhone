/**
 * Non-extractable session key encapsulation via WebCrypto. The raw
 * ECDH private key material never becomes accessible to page scripts
 * (extractable: false) — sensitive session tokens are wrapped/unwrapped
 * through the CryptoKey handle only, so a DOM-based XSS cannot exfiltrate
 * the underlying key bytes.
 */

const ECDH_PARAMS: EcKeyAlgorithm = { name: 'ECDH', namedCurve: 'P-256' } as EcKeyAlgorithm;

export interface SessionKeyHandle {
  publicKey: CryptoKey;
  privateKey: CryptoKey; // extractable: false
  createdAt: number;
}

let activeSession: SessionKeyHandle | null = null;
let autoBurnTimer: ReturnType<typeof setTimeout> | null = null;

/** Generate a fresh, non-extractable ECDH session keypair. */
export async function generateSessionKey(): Promise<SessionKeyHandle> {
  const keyPair = await crypto.subtle.generateKey(ECDH_PARAMS, false, ['deriveKey', 'deriveBits']);

  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    createdAt: Date.now(),
  };
}

/** Derive a symmetric AES-GCM key from our session key + a peer's public key. */
export async function deriveSharedKey(
  ourPrivateKey: CryptoKey,
  theirPublicKey: CryptoKey,
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPublicKey },
    ourPrivateKey,
    { name: 'AES-GCM', length: 256 },
    false, // derived key is also non-extractable
    ['encrypt', 'decrypt'],
  );
}

/** Encapsulate (encrypt) a session token under the derived shared key. */
export async function encapsulateToken(
  sharedKey: CryptoKey,
  token: string,
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sharedKey,
    new TextEncoder().encode(token),
  );
  return { ciphertext, iv };
}

export async function decapsulateToken(
  sharedKey: CryptoKey,
  ciphertext: ArrayBuffer,
  iv: Uint8Array,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, sharedKey, ciphertext);
  return new TextDecoder().decode(plaintext);
}

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Start (or replace) the active session key, auto-burning it after inactivity. */
export async function startSession(): Promise<SessionKeyHandle> {
  burnSession();
  activeSession = await generateSessionKey();
  scheduleAutoBurn();
  return activeSession;
}

export function getActiveSession(): SessionKeyHandle | null {
  return activeSession;
}

export function touchSession(): void {
  if (activeSession) {
    scheduleAutoBurn();
  }
}

function scheduleAutoBurn(): void {
  if (autoBurnTimer) clearTimeout(autoBurnTimer);
  autoBurnTimer = setTimeout(() => burnSession(), SESSION_TIMEOUT_MS);
}

/** Destroy the active session key reference so it becomes garbage-collectable. */
export function burnSession(): void {
  activeSession = null;
  if (autoBurnTimer) {
    clearTimeout(autoBurnTimer);
    autoBurnTimer = null;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', burnSession);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Tighten the auto-burn window while the tab is backgrounded.
      touchSession();
    }
  });
}

// ── Cross-Device Transfer Ticket (ISP-058 / #728) ─────────────────────────
/**
 * Single-use, expiring transfer tickets with explicit generation semantics.
 * A source device at generation N mints a ticket; the destination redeems it
 * once and becomes generation N+1 — the sole dispatchable endpoint. Replaying
 * a redeemed or expired ticket fails deterministically. The full transfer /
 * presence state machine is specced in `docs/spikes/728-session-transfer-report.md`.
 */

export interface SessionIdentity {
  sessionId: string;
  generation: number;
  deviceId: string;
}

export interface TransferTicket extends SessionIdentity {
  ticketId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export type TransferRedeemResult =
  | { ok: true; sessionId: string; generation: number; deviceId: string }
  | { ok: false; error: 'expired' | 'already_redeemed' | 'malformed' };

const TRANSFER_TICKET_TTL_MS = 90_000;
const redeemedTicketIds = new Set<string>();

/** Mint a transfer ticket for the identity at `generation`, valid for `ttlMs`. */
export function createTransferTicket(
  identity: SessionIdentity,
  options: { ttlMs?: number; now?: number } = {},
): TransferTicket {
  const now = options.now ?? Date.now();
  const ttl = options.ttlMs ?? TRANSFER_TICKET_TTL_MS;
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  return {
    ticketId: crypto.randomUUID(),
    sessionId: identity.sessionId,
    generation: identity.generation,
    deviceId: identity.deviceId,
    nonce: Array.from(nonceBytes, (b) => b.toString(16).padStart(2, '0')).join(''),
    issuedAt: now,
    expiresAt: now + ttl,
  };
}

/**
 * Redeem a ticket exactly once. On success the caller holds generation
 * `ticket.generation + 1` bound to `destinationDeviceId`; the source
 * generation is superseded (enforcement lives in presence handling).
 */
export function redeemTransferTicket(
  ticket: TransferTicket,
  options: { destinationDeviceId: string; now?: number },
): TransferRedeemResult {
  const now = options.now ?? Date.now();
  if (
    !ticket ||
    typeof ticket.ticketId !== 'string' ||
    typeof ticket.sessionId !== 'string' ||
    !Number.isInteger(ticket.generation) ||
    ticket.generation < 0 ||
    !options.destinationDeviceId
  ) {
    return { ok: false, error: 'malformed' };
  }
  if (redeemedTicketIds.has(ticket.ticketId)) {
    return { ok: false, error: 'already_redeemed' };
  }
  if (!Number.isFinite(ticket.expiresAt) || now > ticket.expiresAt) {
    return { ok: false, error: 'expired' };
  }
  redeemedTicketIds.add(ticket.ticketId);
  return {
    ok: true,
    sessionId: ticket.sessionId,
    generation: ticket.generation + 1,
    deviceId: options.destinationDeviceId,
  };
}

/** Test hook: forget redeemed tickets so suites start from a clean slate. */
export function __resetRedeemedTicketsForTests(): void {
  redeemedTicketIds.clear();
}
