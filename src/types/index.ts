/**
 * Shared TypeScript types — HelPhone
 */

export interface HelpRequest {
  id: number | string;
  requester: string;
  lat: number | null;
  lng: number | null;
  emergency_type: string;
  status: 'Pending' | 'Enroute' | 'Resolved' | 'Cancelled';
  created_at: number;
  resolved_at?: number | null;
}

export interface Responder {
  responder: string;
  lat: number | null;
  lng: number | null;
  eta_seconds?: number;
  arrived: boolean;
  responded_at: number;
}

export interface WasmMemoryStats {
  totalAllocated: number;
  poolSize: number;
  pooledBuffers: number;
  activeBuffers: number;
  peakAllocated: number;
  recycledCount: number;
  allocationCount: number;
  recyclingRate: number;
  utilisationPct: number;
}

export interface ImageProcessResult {
  blob: Blob;
  originalSize: number;
  compressedSize: number;
  savingsPct: number;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  exifStripped: boolean;
  outputType: string;
  quality: number;
}

export interface PoolStats {
  total: number;
  active: number;
  idle: number;
  waiting: number;
  maxConnections: number;
  idleTimeoutMs: number;
}

export type EmergencyType = 'lost' | 'fallen' | 'medical' | 'car' | 'danger' | 'other';

export interface HelpDraft {
  emergencyType: EmergencyType | string | null
  nickname: string
  contact: string
  location: [number, number] | null
  searchQuery: string
  extra?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}
