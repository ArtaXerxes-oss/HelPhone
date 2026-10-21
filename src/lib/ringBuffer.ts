/**
 * Priority-aware bounded ring buffer for telemetry frames (ISP-032)
 * and client-side view of the contract's bounded verification history (#531 / #797).
 */
import type { ExpertVerificationWindow } from '../types/index';

// ===========================================================================
// Verification Window & Audit Tape (#531 / #797)
// ===========================================================================

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** Derive the readable window from the contract's lifetime total and capacity. */
export function verificationWindow(total: unknown, capacity: unknown): ExpertVerificationWindow {
  const t = toCount(total);
  const c = toCount(capacity);
  const oldest = Math.max(t - c, 0);
  return { total: t, capacity: c, oldest, retained: t - oldest, evicted: oldest };
}

/** Whether logical `index` can still be read from the contract. */
export function isRetained(window: ExpertVerificationWindow, index: number): boolean {
  return Number.isInteger(index) && index >= window.oldest && index < window.total;
}

/**
 * Logical indexes of the newest `limit` retained entries, newest first: what
 * to fetch to show a wallet's recent history without asking for evicted slots.
 */
export function recentIndexes(window: ExpertVerificationWindow, limit: number): number[] {
  const count = Math.min(Math.max(Math.trunc(limit) || 0, 0), window.retained);
  return Array.from({ length: count }, (_, i) => window.total - 1 - i);
}

/**
 * Fixed-capacity audit tape (#797): kill-switch changes, newest overwrites
 * oldest. Capacity is fixed at construction so the tape never grows under
 * memory pressure; `approxBytes` lets heap forensics (#793) account for it.
 */
export interface AuditEntry {
  at: number;
  kind: string;
  from: string;
  to: string;
  reason: string;
}

export function createAuditTape(capacity = 64) {
  const slots: Array<AuditEntry | undefined> = new Array(capacity);
  let total = 0;
  return {
    push(entry: AuditEntry): void {
      slots[total % capacity] = entry;
      total += 1;
    },
    entries(): AuditEntry[] {
      const w = verificationWindow(total, capacity);
      return Array.from({ length: w.retained }, (_, i) => slots[(w.oldest + i) % capacity]!);
    },
    get total(): number {
      return total;
    },
    approxBytes(): number {
      return Math.min(total, capacity) * 96;
    },
  };
}

// ===========================================================================
// ISP-032 Priority-Aware Ring Buffer
// ===========================================================================

export type TelemetryPriority = 'heartbeat' | 'normal' | 'critical';

export type RingDropReason =
  | 'overflow_heartbeat'
  | 'overflow_normal'
  | 'overflow_critical';

export type PressureLevel = 'normal' | 'high' | 'critical';

export interface TelemetryFrame<T = unknown> {
  seq: number;
  priority: TelemetryPriority;
  kind: string;
  ts: number;
  payload: T;
}

export interface RingBufferOptions {
  capacity?: number;
  highWatermark?: number;
  shedWatermark?: number;
  lowWatermark?: number;
}

export interface RingSnapshot {
  capacity: number;
  size: number;
  occupancy: number;
  pressure: PressureLevel;
  offered: number;
  admitted: number;
  rejected: number;
  evicted: number;
  drained: number;
  sampled: number;
  dropped: number;
  droppedReasons: Record<RingDropReason, number>;
  conservation: {
    offeredOk: boolean;
    admittedOk: boolean;
    ok: boolean;
  };
}

export interface PressureEvent {
  level: PressureLevel;
  occupancy: number;
  size: number;
  capacity: number;
}

interface Node<T> {
  frame: TelemetryFrame<T>;
  prev: Node<T> | null;
  next: Node<T> | null;
  active: boolean;
}

const PRIORITY_RANK: Record<TelemetryPriority, number> = {
  heartbeat: 1,
  normal: 2,
  critical: 3,
};

const DROP_REASON: Record<TelemetryPriority, RingDropReason> = {
  heartbeat: 'overflow_heartbeat',
  normal: 'overflow_normal',
  critical: 'overflow_critical',
};

function clampWatermark(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value as number));
}

export class RingBuffer<T = unknown> {
  readonly capacity: number;
  readonly highWatermark: number;
  readonly shedWatermark: number;
  readonly lowWatermark: number;

  private head: Node<T> | null = null;
  private tail: Node<T> | null = null;
  private size = 0;

  private readonly queues: Record<TelemetryPriority, Node<T>[]> = {
    heartbeat: [],
    normal: [],
    critical: [],
  };

  private offered = 0;
  private admitted = 0;
  private rejected = 0;
  private evicted = 0;
  private drained = 0;
  private sampled = 0;

  private readonly droppedReasons: Record<RingDropReason, number> = {
    overflow_heartbeat: 0,
    overflow_normal: 0,
    overflow_critical: 0,
  };

  private pressure: PressureLevel = 'normal';
  private readonly pressureListeners = new Set<(event: PressureEvent) => void>();

  constructor(options: RingBufferOptions = {}) {
    const capacity = Math.max(1, Math.floor(options.capacity ?? 1000));
    this.capacity = capacity;
    this.highWatermark = clampWatermark(options.highWatermark, 0.7);
    this.shedWatermark = clampWatermark(options.shedWatermark, 0.9);
    this.lowWatermark = clampWatermark(options.lowWatermark, 0.5);
  }

  get length(): number {
    return this.size;
  }

  get occupancy(): number {
    return this.size / this.capacity;
  }

  get currentPressure(): PressureLevel {
    return this.pressure;
  }

  push(frame: TelemetryFrame<T>): boolean {
    this.offered++;
    const priority = frame.priority || 'normal';

    if (this.size >= this.capacity) {
      const victim = this.findEvictionVictim();
      if (!victim) {
        this.rejected++;
        this.bumpDrop(priority);
        return false;
      }
      if (PRIORITY_RANK[victim.frame.priority] > PRIORITY_RANK[priority]) {
        this.rejected++;
        this.bumpDrop(priority);
        return false;
      }
      this.bumpDrop(victim.frame.priority);
      this.unlink(victim);
      this.evicted++;
    }

    const node: Node<T> = {
      frame,
      prev: this.tail,
      next: null,
      active: true,
    };
    if (this.tail) this.tail.next = node;
    else this.head = node;
    this.tail = node;

    this.queues[priority].push(node);
    this.size++;
    this.admitted++;
    this.updatePressure();
    return true;
  }

  drain(max = Number.POSITIVE_INFINITY): TelemetryFrame<T>[] {
    const limit = Math.max(0, Math.floor(max));
    const out: TelemetryFrame<T>[] = [];
    while (this.head && out.length < limit) {
      const node = this.head;
      this.unlink(node);
      this.drained++;
      out.push(node.frame);
    }
    if (out.length > 0) this.updatePressure();
    return out;
  }

  peek(): TelemetryFrame<T> | undefined {
    return this.head?.frame;
  }

  recordSampled(count = 1): void {
    if (count > 0) this.sampled += count;
  }

  onPressure(listener: (event: PressureEvent) => void): () => void {
    this.pressureListeners.add(listener);
    return () => this.pressureListeners.delete(listener);
  }

  snapshot(): RingSnapshot {
    const dropped = this.rejected + this.evicted;
    return {
      capacity: this.capacity,
      size: this.size,
      occupancy: this.occupancy,
      pressure: this.pressure,
      offered: this.offered,
      admitted: this.admitted,
      rejected: this.rejected,
      evicted: this.evicted,
      drained: this.drained,
      sampled: this.sampled,
      dropped,
      droppedReasons: { ...this.droppedReasons },
      conservation: {
        offeredOk: this.offered === this.admitted + this.rejected,
        admittedOk:
          this.admitted === this.evicted + this.drained + this.size,
        ok:
          this.offered === this.admitted + this.rejected &&
          this.admitted === this.evicted + this.drained + this.size,
      },
    };
  }

  reset(): void {
    this.head = null;
    this.tail = null;
    this.size = 0;
    this.queues.heartbeat.length = 0;
    this.queues.normal.length = 0;
    this.queues.critical.length = 0;
    this.offered = 0;
    this.admitted = 0;
    this.rejected = 0;
    this.evicted = 0;
    this.drained = 0;
    this.sampled = 0;
    this.droppedReasons.overflow_heartbeat = 0;
    this.droppedReasons.overflow_normal = 0;
    this.droppedReasons.overflow_critical = 0;
    this.setPressure('normal');
  }

  private findEvictionVictim(): Node<T> | undefined {
    for (const priority of ['heartbeat', 'normal', 'critical'] as const) {
      const queue = this.queues[priority];
      while (queue.length > 0 && !queue[0].active) queue.shift();
      if (queue.length > 0) return queue[0];
    }
    return undefined;
  }

  private unlink(node: Node<T>): void {
    node.active = false;
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = null;
    node.next = null;
    this.size--;
  }

  private bumpDrop(priority: TelemetryPriority): void {
    this.droppedReasons[DROP_REASON[priority]]++;
  }

  private updatePressure(): void {
    const occupancy = this.occupancy;
    let next: PressureLevel = this.pressure;

    if (occupancy >= this.shedWatermark) next = 'critical';
    else if (occupancy >= this.highWatermark) next = 'high';
    else if (occupancy <= this.lowWatermark) next = 'normal';

    this.setPressure(next);
  }

  private setPressure(next: PressureLevel): void {
    if (next === this.pressure) return;
    this.pressure = next;
    const event: PressureEvent = {
      level: next,
      occupancy: this.occupancy,
      size: this.size,
      capacity: this.capacity,
    };
    for (const listener of this.pressureListeners) {
      try {
        listener(event);
      } catch {
        // safe
      }
    }
  }
}

export default RingBuffer;
