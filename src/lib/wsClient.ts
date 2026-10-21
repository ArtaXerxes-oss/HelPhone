export type ConnectionState = 'CONNECTING' | 'OPEN' | 'RECONNECTING' | 'FAILED';

/** Origin tag injected into kiosk-sourced intent messages. */
export const KIOSK_ORIGIN_TAG = 'KIOSK-UNVERIFIED' as const;

export interface WsClientOptions {
  url: string;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onStateChange?: (state: ConnectionState) => void;
  onMessage?: (data: unknown) => void;
  onResync?: () => void;
}

/**
 * WebSocket client with exponential backoff + jitter reconnection.
 * Delay sequence: base * 2^attempt, capped at maxDelayMs, with up to
 * 50% random jitter added to avoid thundering-herd reconnects.
 */
export class WsClient {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'CONNECTING';
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manuallyClosed = false;

  private readonly url: string;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(private options: WsClientOptions) {
    this.url = options.url;
    this.maxRetries = options.maxRetries ?? Infinity;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
  }

  connect(): void {
    this.manuallyClosed = false;
    this.setState(this.attempt === 0 ? 'CONNECTING' : 'RECONNECTING');
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      const wasReconnect = this.attempt > 0;
      this.attempt = 0;
      this.setState('OPEN');
      if (wasReconnect) {
        this.options.onResync?.();
      }
    };

    this.ws.onmessage = (event) => {
      try {
        this.options.onMessage?.(JSON.parse(event.data));
      } catch {
        this.options.onMessage?.(event.data);
      }
    };

    this.ws.onclose = () => {
      if (this.manuallyClosed) return;
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.attempt >= this.maxRetries) {
      this.setState('FAILED');
      return;
    }

    const delay = this.computeBackoffDelay(this.attempt);
    this.attempt += 1;
    this.setState('RECONNECTING');

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /** Exponential backoff (1s -> 2s -> 4s -> 8s...) with up to 50% jitter. */
  computeBackoffDelay(attempt: number): number {
    const exponential = Math.min(this.baseDelayMs * Math.pow(2, attempt), this.maxDelayMs);
    const jitter = exponential * 0.5 * Math.random();
    return Math.round(exponential + jitter);
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.options.onStateChange?.(state);
  }

  getState(): ConnectionState {
    return this.state;
  }

  send(data: unknown): void {
    if (this.ws && this.state === 'OPEN') {
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }

  /**
   * Send a message tagged as kiosk-origin. The server / ResponderTracker
   * must treat these as UNVERIFIED and route them to the triage queue rather
   * than auto-dispatching.
   */
  sendKiosk(data: Record<string, unknown>): void {
    this.send({ ...data, origin: KIOSK_ORIGIN_TAG });
  }

  close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }
}

// ── Replay Cache & Peer Dialing (ISP-144) ──────────────────────────────────

export class ReplayCache {
  private cache = new Map<string, number>();
  private readonly windowMs: number;

  constructor(windowMs = 300_000) {
    this.windowMs = windowMs;
  }

  checkAndAdd(nonce: string, timestamp = Date.now()): boolean {
    this.cleanup(timestamp);
    if (this.cache.has(nonce)) return false;
    this.cache.set(nonce, timestamp);
    return true;
  }

  has(nonce: string): boolean {
    return this.cache.has(nonce);
  }

  size(): number {
    return this.cache.size;
  }

  private cleanup(now: number): void {
    for (const [nonce, ts] of this.cache) {
      if (now - ts > this.windowMs) {
        this.cache.delete(nonce);
      }
    }
  }
}

export interface PeerDialingOptions extends WsClientOptions {
  localInstanceId: string;
  peerInstanceId: string;
  signingKey?: string;
  onPeerHandshake?: (status: 'authenticating' | 'authenticated' | 'rejected') => void;
}

export class PeerDialingClient extends WsClient {
  readonly localInstanceId: string;
  readonly peerInstanceId: string;
  private readonly replayCache = new ReplayCache();
  private peerAuthenticated = false;

  constructor(private peerOptions: PeerDialingOptions) {
    super(peerOptions);
    this.localInstanceId = peerOptions.localInstanceId;
    this.peerInstanceId = peerOptions.peerInstanceId;
  }

  sendFederatedEnvelope(envelope: { nonce: string; senderInstance: string; recipientInstance: string; [key: string]: unknown }): boolean {
    if (envelope.recipientInstance !== this.peerInstanceId) {
      return false;
    }
    if (!this.replayCache.checkAndAdd(envelope.nonce)) {
      console.warn(`[PeerDialing] Dropping duplicate nonce: ${envelope.nonce}`);
      return false;
    }
    this.send({
      type: 'peer-relay',
      senderInstance: this.localInstanceId,
      peerInstance: this.peerInstanceId,
      envelope,
    });
    return true;
  }

  isPeerAuthenticated(): boolean {
    return this.peerAuthenticated;
  }

  markPeerAuthenticated(authenticated: boolean): void {
    this.peerAuthenticated = authenticated;
    this.peerOptions.onPeerHandshake?.(authenticated ? 'authenticated' : 'rejected');
  }
}

