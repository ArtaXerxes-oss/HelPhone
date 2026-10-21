/**
 * ZK Prover Service
 * Handles ZK proof generation API calls and blockchain RPC interactions
 */

import { api, ApiRequestOptions } from './api';

export interface ProofZone {
  boxXMin: string;
  boxXMax: string;
  boxYMin: string;
  boxYMax: string;
  radiusMeters?: number | null;
  center?: { lat: number; lng: number } | null;
}

export interface LocationProofInputs {
  lat: number;
  lng: number;
  campaignId?: string;
  recipientAddress: string;
  zone?: Partial<ProofZone>;
}

export interface ZKProofRequest {
  inputs: {
    user_x: string;
    user_y: string;
    secret_id: string;
    box_x_min: string;
    box_x_max: string;
    box_y_min: string;
    box_y_max: string;
    campaign_id: string;
    recipient_address: string;
  };
}

export interface ZKProofResponse {
  success: boolean;
  proof?: string;
  nullifier?: string;
  error?: string;
}

export interface HealthCheckResponse {
  ready?: boolean;
  status?: string;
  [key: string]: any;
}

export interface BlockchainRPCRequest {
  method: string;
  params?: any[];
  id?: number | string;
  jsonrpc?: '2.0';
}

export interface BlockchainRPCResponse<T = any> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

class ZKProverService {
  private baseURL: string;
  private defaultOptions: ApiRequestOptions;

  constructor(baseURL?: string, options: ApiRequestOptions = {}) {
    this.baseURL = baseURL || this.resolveProverURL();
    this.defaultOptions = {
      timeout: 10 * 60 * 1000, // 10 minutes for proof generation
      retries: 1,
      retryDelay: 2000,
      ...options,
    };
  }

  /**
   * Resolve ZK prover URL from environment or defaults
   */
  private resolveProverURL(): string {
    const configured = (import.meta.env.VITE_ZK_PROVER_URL || '').trim();
    const url = configured || '/zk';
    
    if (import.meta.env.PROD && url === '/zk') {
      return 'https://helphone.onrender.com';
    }
    
    return url.replace(/\/$/, '');
  }

  /**
   * Check if ZK prover server is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await api.get<HealthCheckResponse>(
        `${this.baseURL}/zk/health`,
        {
          timeout: 2500,
          retries: 0,
        }
      );
      
      return response.status === 200 && response.data.ready !== false;
    } catch (error) {
      console.warn('ZK prover health check failed:', error);
      return false;
    }
  }

  /**
   * Request a ZK proof from the prover server
   */
  async requestProof(inputs: ZKProofRequest['inputs']): Promise<ZKProofResponse> {
    try {
      const response = await api.post<ZKProofResponse>(
        `${this.baseURL}/zk/prove`,
        { inputs },
        this.defaultOptions
      );
      
      return response.data;
    } catch (error) {
      console.error('Failed to request ZK proof:', error);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Generate a location proof with proper error handling
   */
  async generateLocationProof(
    lat: number,
    lng: number,
    recipientAddress: string,
    campaignId: string = '1',
    zone?: Partial<ProofZone>,
    secretId?: string
  ): Promise<ZKProofResponse> {
    // Encode coordinates
    const encodeLng = (lng: number): string => {
      return String(Math.floor(lng * 1e7) + 1_800_000_000);
    };

    const encodeLat = (lat: number): string => {
      return String(Math.floor(lat * 1e7) + 900_000_000);
    };

    // Get or create secret ID
    const secret = secretId || this.getOrCreateSecret();

    // Normalize zone
    const normalizedZone = this.normalizeZone(zone);

    // Prepare inputs
    const inputs: ZKProofRequest['inputs'] = {
      user_x: encodeLng(lng),
      user_y: encodeLat(lat),
      secret_id: secret,
      box_x_min: normalizedZone.boxXMin,
      box_x_max: normalizedZone.boxXMax,
      box_y_min: normalizedZone.boxYMin,
      box_y_max: normalizedZone.boxYMax,
      campaign_id: campaignId,
      recipient_address: this.addressToField(recipientAddress),
    };

    return await this.requestProof(inputs);
  }

  /**
   * Convert Stellar address to field element
   */
  private addressToField(stellarAddress: string): string {
    // Simplified implementation - actual implementation would use StrKey.decodeEd25519PublicKey
    // For now, return a placeholder implementation
    const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    
    // Create a deterministic hash from the address
    let hash = 0n;
    for (let i = 0; i < stellarAddress.length; i++) {
      hash = (hash * 31n + BigInt(stellarAddress.charCodeAt(i))) % FIELD_PRIME;
    }
    
    return String(hash);
  }

  /**
   * Get or create secret from localStorage
   */
  private getOrCreateSecret(): string {
    const KEY = 'hp_zk_secret';
    try {
      const stored = localStorage.getItem(KEY);
      if (stored) return stored;
      
      // Generate random secret
      const bytes = new Uint8Array(31);
      crypto.getRandomValues(bytes);
      let value = 0n;
      for (const b of bytes) value = (value << 8n) | BigInt(b);
      
      const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
      const secret = String(value % FIELD_PRIME);
      
      localStorage.setItem(KEY, secret);
      return secret;
    } catch {
      // Fallback if localStorage fails
      return '1';
    }
  }

  /**
   * Normalize proof zone
   */
  private normalizeZone(zone?: Partial<ProofZone>): ProofZone {
    if (!zone) {
      return {
        boxXMin: '0',
        boxXMax: '3600000000',
        boxYMin: '0',
        boxYMax: '1800000000',
        radiusMeters: null,
        center: null,
      };
    }

    // Validate required fields
    const required = ['boxXMin', 'boxXMax', 'boxYMin', 'boxYMax'];
    for (const key of required) {
      if (zone[key as keyof ProofZone] === undefined || zone[key as keyof ProofZone] === null) {
        throw new Error(`Invalid ZK proof zone: ${key} is required`);
      }
    }

    return {
      boxXMin: String(Math.trunc(Number(zone.boxXMin))),
      boxXMax: String(Math.trunc(Number(zone.boxXMax))),
      boxYMin: String(Math.trunc(Number(zone.boxYMin))),
      boxYMax: String(Math.trunc(Number(zone.boxYMax))),
      radiusMeters: zone.radiusMeters ?? null,
      center: zone.center ?? null,
    };
  }

  /**
   * Make a blockchain RPC call
   */
  async blockchainRPC<T = any>(
    url: string,
    method: string,
    params: any[] = [],
    options: ApiRequestOptions = {}
  ): Promise<T> {
    const rpcRequest: BlockchainRPCRequest = {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    };

    try {
      const response = await api.post<BlockchainRPCResponse<T>>(
        url,
        rpcRequest,
        {
          timeout: 30000,
          retries: 1,
          retryDelay: 1000,
          ...options,
        }
      );

      if (response.data.error) {
        throw new Error(
          `RPC error ${response.data.error.code}: ${response.data.error.message}`
        );
      }

      if (response.data.result === undefined) {
        throw new Error('RPC response missing result');
      }

      return response.data.result;
    } catch (error) {
      console.error(`Blockchain RPC call failed (${method}):`, error);
      throw error;
    }
  }

  /**
   * Fetch with timeout (compatibility wrapper)
   */
  async fetchWithTimeout(
    url: string,
    options: RequestInit = {},
    timeoutMs = 30000
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// Export singleton instance with default configuration
export const zkProverService = new ZKProverService();

export default ZKProverService;