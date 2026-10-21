/**
 * Network-class estimation + per-device OTel batch tunables.
 *
 * The telemetry pipeline must not use one batching policy for every device.
 * A 2G handset needs few, infrequent exports; a 4G device can afford larger
 * batches. This module is deliberately dependency-free and side-effect-free
 * so it can run in the browser, a worker, and Node tests.
 */

export type NetworkClass = 'offline' | '2g' | '3g' | '4g';

export interface NetworkSample {
  online?: boolean;
  effectiveType?: string;
  downlinkMbps?: number;
  rttMs?: number;
  saveData?: boolean;
}

export interface NetworkProfile {
  /** OTel BatchSpanProcessor maxQueueSize analogue. */
  maxQueueSize: number;
  /** OTel scheduledDelayMillis analogue. */
  scheduledDelayMillis: number;
  /** OTel maxExportBatchSize analogue. */
  maxExportBatchSize: number;
  /** Fraction of normal-priority spans kept at normal ring pressure. */
  normalSampleRate: number;
  /** Fraction of heartbeat spans kept at normal ring pressure. */
  heartbeatSampleRate: number;
  /** Dispatch-critical spans are never sampled. */
  criticalSampleRate: 1;
  /** When true, exports are diverted to the durable outbox instead of memory. */
  outboxOnly: boolean;
}

export const NETWORK_PROFILES: Record<NetworkClass, NetworkProfile> = {
  // 2G: ≤20% of a mixed baseline (80% normal / 20% heartbeat) survives,
  // while dispatch-critical spans are preserved at 100%.
  '2g': {
    maxQueueSize: 50,
    scheduledDelayMillis: 5_000,
    maxExportBatchSize: 5,
    normalSampleRate: 0.2,
    heartbeatSampleRate: 0.02,
    criticalSampleRate: 1,
    outboxOnly: false,
  },
  '3g': {
    maxQueueSize: 200,
    scheduledDelayMillis: 2_000,
    maxExportBatchSize: 20,
    normalSampleRate: 0.5,
    heartbeatSampleRate: 0.1,
    criticalSampleRate: 1,
    outboxOnly: false,
  },
  '4g': {
    maxQueueSize: 1_000,
    scheduledDelayMillis: 1_000,
    maxExportBatchSize: 200,
    normalSampleRate: 1,
    heartbeatSampleRate: 0.25,
    criticalSampleRate: 1,
    outboxOnly: false,
  },
  offline: {
    maxQueueSize: 100,
    scheduledDelayMillis: 0,
    maxExportBatchSize: 50,
    normalSampleRate: 1,
    heartbeatSampleRate: 0.05,
    criticalSampleRate: 1,
    outboxOnly: true,
  },
};

/** Pure classifier — the single source of truth for every runtime. */
export function classifyNetwork(sample: NetworkSample = {}): NetworkClass {
  if (sample.online === false) return 'offline';
  if (sample.saveData) return '2g';

  const effective = String(sample.effectiveType || '').toLowerCase();
  if (effective === 'slow-2g' || effective === '2g') return '2g';
  if (effective === '3g') return '3g';
  if (effective === '4g') return '4g';

  const rtt = sample.rttMs;
  const downlink = sample.downlinkMbps;

  if (Number.isFinite(rtt) && (rtt as number) >= 1_000) return '2g';
  if (Number.isFinite(downlink) && (downlink as number) >= 0 && (downlink as number) < 0.5) return '2g';
  if (Number.isFinite(rtt) && (rtt as number) >= 300) return '3g';
  if (Number.isFinite(downlink) && (downlink as number) >= 0 && (downlink as number) < 1.5) return '3g';

  // No signal at all is treated as a healthy device, not as offline: the
  // browser may not expose NetworkInformation at all (Safari/Firefox).
  return '4g';
}

export function profileFor(networkClass: NetworkClass): NetworkProfile {
  return NETWORK_PROFILES[networkClass] ?? NETWORK_PROFILES['4g'];
}

type ConnectionLike = {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
};

function connectionOf(env: unknown): ConnectionLike | undefined {
  const nav = (env as { navigator?: { connection?: ConnectionLike; onLine?: boolean } } | undefined)?.navigator;
  return nav?.connection;
}

/** Read the ambient network state (browser or injected environment). */
export function estimateNetwork(env: unknown = globalThis): NetworkClass {
  const nav = (env as { navigator?: { onLine?: boolean; connection?: ConnectionLike } } | undefined)?.navigator;
  const connection = nav?.connection;
  return classifyNetwork({
    online: nav?.onLine,
    effectiveType: connection?.effectiveType,
    downlinkMbps: connection?.downlink,
    rttMs: connection?.rtt,
    saveData: connection?.saveData,
  });
}

export interface NetworkMonitor {
  get(): NetworkClass;
  subscribe(listener: (networkClass: NetworkClass) => void): () => void;
  stop(): void;
}

/**
 * Subscribe to browser connectivity changes. Returns a monitor with an
 * explicit `stop()` so React effects and workers can release listeners.
 */
export function createNetworkMonitor(env: unknown = globalThis, intervalMs = 0): NetworkMonitor {
  const nav = (env as {
    navigator?: { onLine?: boolean; connection?: ConnectionLike };
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  } | undefined)?.navigator;

  const listeners = new Set<(networkClass: NetworkClass) => void>();
  let current = estimateNetwork(env);
  let timer: ReturnType<typeof setInterval> | null = null;

  const emit = () => {
    const next = estimateNetwork(env);
    if (next === current) return;
    current = next;
    for (const listener of listeners) listener(next);
  };

  const connection = nav?.connection;
  const onConnectionChange = () => emit();

  if (nav?.addEventListener) nav.addEventListener('online', emit);
  if (nav?.addEventListener) nav.addEventListener('offline', emit);
  connection?.addEventListener?.('change', onConnectionChange);
  if (intervalMs > 0) timer = setInterval(emit, intervalMs);

  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      listeners.clear();
      if (timer) clearInterval(timer);
      timer = null;
      nav?.removeEventListener?.('online', emit);
      nav?.removeEventListener?.('offline', emit);
      connection?.removeEventListener?.('change', onConnectionChange);
    },
  };
}
