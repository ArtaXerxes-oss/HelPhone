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
