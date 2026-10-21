export type TraversalMode = 'host' | 'srflx' | 'relay' | 'unknown'
export type RealtimeTransport = 'probing' | 'webrtc' | 'websocket'
export interface IceCandidateMetric {
  mode: TraversalMode
  gatheredAtMs: number
  protocol: string
}
export interface IceBenchmarkResult {
  candidates: IceCandidateMetric[]
  gatheringMs: number
  success: boolean
  hasRelay: boolean
  recommendedTransport: Exclude<RealtimeTransport, 'probing'>
}
// ── Domain interfaces for HelPhone ───────────────────────────────────────────

/** On-chain request status values returned by the Soroban contract. */
export type RequestStatus = 'Pending' | 'Enroute' | 'Resolved' | 'Cancelled'

/** Priority level for a help request. */
export type PriorityLevel = 'Low' | 'Medium' | 'High' | 'Critical'

/** A help request as decoded from the Soroban contract. */
export interface HelpRequest {
  id: number
  requester: string
  lat: number | null
  lng: number | null
  emergency_type: string
  nickname: string
  contact: string
  status: RequestStatus
  priority: PriorityLevel
  created_at: number
  resolved_at: number | null
}

/** A responder entry attached to a request. */
export interface Responder {
  /** Composite id: `${requestId}-${index}` */
  id: string
  responder: string
  lat: number | null
  lng: number | null
  eta_seconds: number | null
  arrived: boolean
  responded_at: number
}

/** Ranking entry returned by `get_ranking`. */
export interface RankingEntry {
  responder: string
  total_arrivals: number
}

// ── ZK Proof interfaces ───────────────────────────────────────────────────────

/** A bounding box used in the ZK location proof. */
export interface ProofZone {
  boxXMin: string
  boxXMax: string
  boxYMin: string
  boxYMax: string
  radiusMeters: number | null
  center: { lat: number; lng: number } | null
}

/** Result returned by generateLocationProof / _requestServerProof. */
export interface LocationProof {
  proof: Uint8Array
  publicInputsBytes: Uint8Array
  publicInputsPrefix: Uint8Array
  nullifier: string
  zone: ProofZone
  publicInputs?: unknown
}

/**
 * Persisted ZK checkpoint stored in component state after a successful proof.
 * Includes the original proof plus on-chain transaction hashes recorded
 * after Stellar confirmation.
 */
export interface ZkCheckpoint {
  scope: string
  campaignId: string
  nullifier: string
  proof: LocationProof
  zone: ProofZone
  createdAt: string
  /** Transaction hash of the primary on-chain action (create/accept request). */
  txHash?: string
  /** Request id linked to this checkpoint once created. */
  requestId?: number
  /** Transaction hash of the proof fingerprint record on Stellar. */
  recordTxHash?: string
}

/** All possible status values for the ZK proof pipeline. */
export type ZkStatus = 'idle' | 'proving' | 'proved' | 'recording' | 'recorded' | 'error'

/** Shape of the zkReducer state. */
export interface ZkState {
  status: ZkStatus
  logs: string[]
  proof: ZkCheckpoint | null
  error: string
}

// ── Application state interfaces ─────────────────────────────────────────────

/** User profile stored in localStorage. */
export interface UserProfile {
  nickname: string
  contact: string
}

/** A fully accepted offer receipt held in component state. */
export interface OfferReceipt {
  requestId: number
  label: string
  emergencyType: string
  txHash: string
  proofId: string
  at: string
  arrivalTxHash?: string
}

// ── Wallet interfaces ─────────────────────────────────────────────────────────

/** Minimal shape of the StellarWalletsKit instance used across the app. */
export interface WalletKit {
  authModal(): Promise<{ address: string }>
  getAddress(): Promise<{ address: string }>
  disconnect(): Promise<void>
  signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<string | { signedTxXdr: string }>
  on(event: string, handler: (event?: unknown) => void): () => void
}

// ── Open source sustainability reserve (#587) ───────────────────────────────

/** `get_sustainability_stats` from contracts/helphone_dao, normalized. */
export interface SustainabilityStats {
  /** SAC token the reserve is held in; null until the admin configures it. */
  token: string | null
  /** Basis points of each protocol transaction routed to the reserve (100 = 1%). */
  feeBps: number
  reserve: number
  totalCollected: number
  totalDisbursed: number
  grantsProposed: number
  grantsDisbursed: number
  maintainersFunded: number
}

export type GrantStatus = 'Pending' | 'Disbursed'

/** A DAO-voted grant to an open source dependency maintainer. */
export interface MaintainerGrant {
  proposalId: number
  maintainer: string
  /** Dependency identifier, e.g. "npm:@stellar/stellar-sdk". */
  package: string
  amount: number
  status: GrantStatus
  disbursedAt: number | null
}

/**
 * HelPhone System-Wide TypeScript Definitions
 */

export type DaoProposalStatus = 'Active' | 'Passed' | 'Queued' | 'Failed' | 'Executed' | 'Cancelled'

export interface DaoTimelockState {
  queued_at: number
  execute_after: number
}

export interface DaoProposalSummary {
  id: number
  status: DaoProposalStatus
  timelock: DaoTimelockState | null
  cancellationApprovals: number
  cancellationThreshold: number
}

// --- Feature Flags Subsystem ---
export interface FeatureFlagRuleset {
  enabled: boolean
  rolloutPercentage?: number
  targets?: {
    roles?: string[]
    environments?: string[]
    userIds?: string[]
  }
  environmentOverrides?: Record<string, boolean>
}

export interface FeatureFlagConfig {
  version: string
  updatedAt?: string
  flags: Record<string, FeatureFlagRuleset>
}

export interface UserContext {
  id?: string
  role?: string
  environment?: string
  deviceId?: string
}

export interface FlagEvaluationResult {
  flagKey: string
  enabled: boolean
  reason: 'default' | 'env_override' | 'target_match' | 'percentage_rollout' | 'disabled'
}

// --- Soroban State & Exporter Subsystem ---
export interface SorobanStorageEntry {
  key: string
  val: any
  durability: 'instance' | 'persistent' | 'temporary'
  lastModifiedLedgerSeq?: number
}

export interface ContractStateSnapshot {
  ledgerSequence: number
  contractId: string
  timestamp: string
  entries: SorobanStorageEntry[]
  metadata: {
    exporterVersion: string
    totalEntries: number
    networkPassphrase: string
    rpcUrl: string
  }
}

// --- Cryptography & WebAuthn / Passkey Subsystem ---
export interface PasskeyCredential {
  id: string
  rawId: string
  type: 'public-key'
  challenge?: string
  response: {
    clientDataJSON?: string
    authenticatorData?: string
    signature?: string
    attestationObject?: string
    transports?: string[]
    userHandle?: string
  }
}

export interface WebAuthnVerificationResult {
  verified: boolean
  publicKeyHex?: string
  counter?: number
  userHandle?: string
  error?: string
}

export interface CryptoKeyPair {
  publicKey: string
  secretKey: string
}

export interface SignaturePayload {
  message: string
  signature: string
  publicKey: string
  algorithm: 'ed25519' | 'webauthn-p256' | 'aes-gcm'
  timestamp: number
  nonce?: string
}

export interface EncryptedData {
  ciphertext: string
  iv: string
  authTag: string
  algorithm: 'AES-GCM'
}

// --- End-to-End Encrypted Emergency Payloads (E2EE) ---
//
// The sensitive half of a help request (contact number, medical notes,
// allergies) never reaches the ledger or the relay in the clear. It is sealed
// into an `EncryptedEnvelope` with a one-shot content key, and that content key
// is wrapped once per authorized recipient with ECDH P-256 + HKDF-SHA256.
// Only holders of a recipient private key can open it — the relay stores and
// forwards opaque bytes and never holds a decryption key.
//
// Note what is deliberately NOT here: `lat`, `lng` and `emergencyType` stay in
// plaintext. Responders have to see *where* and *what kind* of emergency it is
// to be dispatched at all; concealing them would break the product's core
// function (and location privacy is handled by the separate ZK/Aegis layer).
// See docs/security-architecture.md → "End-to-End Encrypted Payloads".

/** The plaintext that gets sealed. Field names double as the JSON keys. */
export interface EmergencyPayload {
  /** Phone number or handle the requester wants responders to call. */
  contact: string
  /** Free-text medical notes (allergies, medications, conditions). */
  medicalNotes: string
  /** Display name shown to responders. */
  nickname: string
  /** Optional separate allergies field, merged into `medicalNotes` when empty. */
  allergies?: string
  /** Unix ms the requester composed the payload. */
  requestedAt?: number
}

/** One recipient's copy of the content key, sealed to that recipient's key. */
export interface WrappedContentKey {
  /**
   * SHA-256 of the recipient's uncompressed P-256 public key, first 8 bytes
   * hex. Lets a client find its own wrap without trial-decrypting the others,
   * and binds the wrap to the key (it is authenticated as AAD).
   */
  keyId: string
  /** Hex-encoded wrapped content key (32 bytes + 16-byte GCM tag). */
  wrappedKey: string
  /** Hex 12-byte IV used only for this wrap. */
  wrapIv: string
  /** Hex 16-byte GCM tag over the wrap. */
  wrapAuthTag: string
}

/**
 * Self-describing sealed envelope. Serialized to the ledger as opaque bytes,
 * so the contract never has to parse or validate the format — it only bounds
 * the length. `version` lets the layout rotate without a flag day.
 */
export interface EncryptedEnvelope {
  /** Envelope format version. Only `1` is understood today. */
  version: 1
  /** Algorithm identifier, checked on decrypt so a downgrade is rejected. */
  algorithm: 'ECDH-P256-HKDF-SHA256+AES-256-GCM'
  /**
   * Public id the payload is bound to, mixed into the AEAD tags. Tamper-evident
   * (editing it invalidates the tag) but not secret, so a responder can read it
   * off the envelope without out-of-band coordination.
   *
   * Normally a client-generated submission id, because the on-chain request id
   * is not known until `create_request` has already been signed. Pass the
   * ledger request id instead when it is known up front.
   */
  bindingContext: string
  /** Hex uncompressed SEC1 P-256 ephemeral public key (65 bytes, `04` prefix). */
  ephemeralPublicKey: string
  /** Hex 12-byte IV for the payload. */
  iv: string
  /** Hex ciphertext of the canonical payload JSON. */
  ciphertext: string
  /** Hex 16-byte GCM tag over the payload. */
  authTag: string
  /** One wrap per authorized recipient, including the requester. */
  wrappedKeys: WrappedContentKey[]
  /** Unix ms the envelope was produced. */
  createdAt: number
}

/** A responder's advertised public key, as held by the relay. */
export interface ResponderEncryptionKey {
  /** Stellar account the key is bound to (the on-chain identity). */
  wallet: string
  /** Hex uncompressed SEC1 P-256 public key. */
  publicKey: string
  /**
   * SHA-256 prefix of the public key, in lowercase hex. Deterministic, so the
   * same key always presents the same id and an envelope can be matched to its
   * `wrappedKeys` entry without trusting registry order.
   */
  keyId: string
  /** Unix ms the key was registered. */
  registeredAt: number
}

/** A help request exactly as the ledger holds it, after `mapRequest`. */
export type RequestStatus = 'Pending' | 'Enroute' | 'Resolved' | 'Cancelled'

/**
 * A help request as the client sees it.
 *
 * `encryptedPayload` is the sealed envelope, still sealed — reading the
 * contact number or medical notes requires calling `decryptEmergencyPayload`
 * with a recipient private key. It is `null` only for a request sealed before
 * E2EE existed, which the contract can no longer represent; treat it as
 * "no responder-only details available" rather than "no details".
 */
export interface HelpRequest {
  id: number
  requester: string
  /** Degrees. */
  lat: number
  /** Degrees. */
  lng: number
  emergency_type: string
  /** Opaque sealed envelope; `null` when absent. */
  encrypted_payload: EncryptedEnvelope | null
  status: RequestStatus
  /** Client-side display only; not a contract field. */
  priority: 'Low' | 'Medium' | 'High' | 'Critical'
  created_at: number
  resolved_at: number | null
}

/** A help request as the contract stores it — `lat`/`lng` are integers. */
export interface HelpRequestRecord {
  id: number
  requester: string
  /** Degrees × 1_000_000. */
  lat: number
  /** Degrees × 1_000_000. */
  lng: number
  emergency_type: string
  /** Hex-encoded sealed envelope as submitted to `create_request`. */
  encrypted_payload: string | null
  status: RequestStatus
  created_at: number
  resolved_at: number | null
}

/** A help request as stored by the relay, keyed by request. */
export interface DispatchEnvelopeRecord {
  requestId: string
  envelope: EncryptedEnvelope
  storedAt: number
}

export interface DispatchStoreResponse {
  success: boolean
  requestId?: string
  /** Number of recipient wraps the relay accepted. */
  recipientCount?: number
  error?: string
}

export interface DispatchFetchResponse {
  success: boolean
  envelopes?: EncryptedEnvelope[]
  error?: string
}

export interface DispatchRecipientResponse {
  success: boolean
  keys?: ResponderEncryptionKey[]
  error?: string
}

// --- Wallet & State Context ---
export interface WalletState {
  address: string | null
  network: string
  isConnected: boolean
  walletType: string | null
  passkeyEnabled: boolean
}

// --- Soroban Footprint Inspection (#517) ---
export interface SorobanFootprintKey {
  type: 'readOnly' | 'readWrite'
  /** Base64 xdr.LedgerKey payload (opaque in the API layer). */
  xdr: string
}

export interface SorobanFootprint {
  contractId: string
  functionName: string
  readOnly: SorobanFootprintKey[]
  readWrite: SorobanFootprintKey[]
  resourceFee: string
  footprintXdr: string
  generatedAt: number
}

export interface SorobanFootprintTemplate {
  contractId: string
  functionName: string
  argsKey: string
  readOnlyCount: number
  readWriteCount: number
  resourceFee: string
  footprintXdr: string
}

export interface SorobanFootprintCacheStats {
  size: number
  maxEntries: number
  ttlMs: number
  hits: number
  misses: number
}

export interface SorobanFootprintInspectRequest {
  contractId: string
  functionName: string
  args?: unknown[]
}

export interface SorobanFootprintInspectResponse {
  success: boolean
  template?: SorobanFootprintTemplate
  error?: string
}
// --- Client Storage Encryption ---
export interface KeyDerivationBenchmark {
  iterations: number
  runs: number
  medianMs: number
  maxMs: number
  budgetMs: number
  withinBudget: boolean
}

// --- Map Overlay Rendering ---
export type OverlayKind = 'pending' | 'enroute' | 'resolved' | 'responder'

/** A marker drawn on the community map's canvas overlay, in map (viewBox) units. */
export interface MapOverlay {
  id: string
  x: number
  y: number
  kind: OverlayKind
}

export interface OverlayRenderStats {
  fps: number
  frames: number
  windowMs: number
}

// ── RPC health (network estimator, #539) ─────────────────────────────────────
/** 'unknown' = no estimator registered yet. */
export type NetworkQuality = 'good' | 'degraded' | 'offline' | 'unknown';

export interface EndpointHealth {
  /** Hostname only — endpoint URLs can embed API keys and are never exposed. */
  label: string;
  /** Smoothed (EWMA) round-trip time in ms, or null before the first probe. */
  latencyMs: number | null;
  lastLatencyMs: number | null;
  healthy: boolean;
  consecutiveFailures: number;
  lastCheckedAt: number | null;
  active: boolean;
  primary: boolean;
}

export interface RpcHealthSnapshot {
  activeLabel: string;
  activeLatencyMs: number | null;
  quality: NetworkQuality;
  endpoints: EndpointHealth[];
}

// ── Image watermarking (#537) ────────────────────────────────────────────────
/** Steganographic payload embedded in an image's pixel LSBs. */
export interface WatermarkPayload {
  v: 1;
  /** Unix seconds. */
  ts: number;
  /** Random nonce (hex). */
  n: string;
  /** SHA-256 of the pixels with RGB LSBs cleared. */
  d: string;
  /** SHA-256 of `${ts}:${n}` — the cryptographic timestamp hash. */
  h: string;
  /** Optional coarse location as integer hundredths of a degree [lat, lng]. */
  loc?: [number, number];
  /** Optional help-request id. */
  rid?: string;
}

/** What the ledger stores for a registered watermark. */
export interface LedgerWatermarkRecord {
  digest: string;
  timestamp: number;
  /** Account that registered it, if the ledger records one. */
  registrant?: string;
}

export type WatermarkStatus =
  | 'authentic'
  | 'ledger-unchecked'
  | 'unregistered'
  | 'ledger-mismatch'
  | 'tampered'
  | 'corrupted'
  | 'no-watermark';

export interface WatermarkVerification {
  status: WatermarkStatus;
  payload?: WatermarkPayload;
  /** Ledger key: SHA-256 of the payload bytes. */
  id?: string;
  record?: LedgerWatermarkRecord;
}


// --- Zone differential privacy (aegis_vault privacy.rs, #529) ---
/** Mirrors the vault's `PrivacyParams`. Numbers are stored-coordinate units. */
export interface ZonePrivacyParams {
  enabled: boolean
  /** epsilon x 1000 (1000 = epsilon of 1.0). */
  epsilonMilli: number
  sensitivity: number
  /** The `t` in the Laplace tail bound `b * t`. */
  tailMult: number
  /** Cell size that zone edges must align to. */
  grid: number
  /** Minimum grid cells any overlap of two zones must still cover. */
  kCells: number
}

export type ZonePrivacyViolation =
  | 'invalid_params'
  | 'malformed'
  | 'not_on_grid'
  | 'too_small'
  | 'overlap_too_small'

// --- Multi-Asset Treasury (#541) & Price Oracle (#543) ---
export interface TreasuryAssetRow {
  asset: string
  reserve: number
  /** Infinity when no cap is configured (i128::MAX on-chain). */
  dailyLimit: number
  spentToday: number
  remainingToday: number
  targetWeightBps: number
}

export interface DisbursementUsage {
  unlimited: boolean
  /** 0-100, capped. */
  pct: number
  remaining: number
  exhausted: boolean
}

export interface OracleQuote {
  fromToken: string
  toToken: string
  amountIn: number
  amountOut: number
}

export type OracleErrorKind = 'stale' | 'unavailable' | 'invalid' | 'not-configured' | 'unknown'

// --- Bounded Expert Verification History (contract ring buffer, #531) ---
/**
 * A wallet's verification history is a fixed-capacity ring buffer. Entries have
 * a logical index that only ever grows; once `total` exceeds `capacity` the
 * oldest indexes are evicted and read back as `null`.
 */
export interface ExpertVerificationWindow {
  /** Verifications ever recorded, evicted ones included; the next entry's index. */
  total: number
  /** Most entries the contract retains per wallet. */
  capacity: number
  /** Logical index of the oldest entry still readable. */
  oldest: number
  /** Entries currently readable (`total - oldest`, never above `capacity`). */
  retained: number
  /** Entries that have been evicted (`oldest`). */
  evicted: number
}

// --- Worker Sandbox Isolation (untrusted Web Worker scripts) ---
/**
 * The sandbox lives next to the code that enforces it
 * (`src/lib/workerSandbox.ts`) so the runtime and the types can never drift;
 * this section re-exports the public surface for app-level imports.
 *
 * - `WorkerSandboxViolation` — one rejected payload or degradation event
 * - `WorkerSandboxOptions` — per-launch knobs (origin mode, test seams, …)
 * - `WorkerSandboxViolationCode` — stable codes: `inbound-schema`,
 *   `outbound-schema`, `boot-failure`, `frame-timeout`, `queue-overflow`,
 *   `transport-error`
 * - `WorkerLockdownReport` — what the in-worker lockdown revoked
 * - `WorkerOriginMode` — `'opaque'` (null origin) or `'same-origin'`
 */
export type {
  SandboxTransport,
  SandboxFrame,
  SandboxViolationCode,
  WorkerLockdownReport,
  WorkerOriginMode,
  WorkerSandboxOptions,
  WorkerSandboxSupport,
  WorkerSandboxViolation,
  WorkerSchemas,
} from '../lib/workerSandbox'

// --- Routing & Graph Data Structures (offline routing) ---
export interface RouteResult {
  /** Distance in kilometres. */
  distanceKm: number
  /** Ordered list of node indices forming the path from source to destination. */
  path: number[]
}

export interface SpatialGraph {
  /** Total node count in the graph. */
  nodeCount: number
  /** Adjacency list: edgeOffsets[n] → index in edgeDests/edgeWeights for node n. */
  edgeOffsets: Uint32Array
  /** Edge destination nodes (one per edge). */
  edgeDests: Uint32Array
  /** Edge weights in metres (one per edge). */
  edgeWeights: Float32Array
}

export interface RoadNetworkDocument {
  version: number
  nodeCount: number
  edgeCount: number
  /** Compressed adjacency list + weights as typed arrays. */
  graph: SpatialGraph
}
