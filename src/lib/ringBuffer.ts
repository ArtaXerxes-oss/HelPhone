/**
 * Priority-aware bounded ring buffer for telemetry frames.
 *
 * Design goals:
 *  - Never silently overwrite the oldest frame. Every eviction is counted and
 *    reason-coded.
 *  - Dispatch-critical frames are never dropped before heartbeat frames:
 *    when the ring is full, a heartbeat is evicted first, then a normal frame,
 *    and only then another critical frame.
 *  - Occupancy is a first-class signal (70% high, 90% critical, 50% resume)
 *    with hysteresis so producers and workers can react without oscillating.
 *
 * The implementation is O(1) per admitted/evicted frame: insertion order is a
 * doubly linked list, and each priority has a FIFO of nodes (stale entries are
 * skipped lazily when they are popped).
 */

export type TelemetryPriority = 'heartbeat' | 'normal' | 'critical';

export type RingDropReason =
  | 'overflow_heartbeat'
  | 'overflow_normal'
  | 'overflow_critical';

export type PressureLevel = 'normal' | 'high' | 'critical';

export interface TelemetryFrame<T = unknown> {
  /** Monotonic producer sequence, used for conservation checks + sampling. */
  seq: number;
  priority: TelemetryPriority;
  kind: string;
  ts: number;
  payload: T;
}

export interface RingBufferOptions {
  capacity?: number;
  /** Occupancy at which `high` pressure is reported. */
  highWatermark?: number;
  /** Occupancy at which producers should shed / worker should pause. */
  shedWatermark?: number;
  /** Occupancy below which pressure returns to `normal`. */
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
    /** offered === admitted + rejected */
    offeredOk: boolean;
    /** admitted === evicted + drained + size */
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
  private readonly highWatermark: number;
  private readonly shedWatermark: number;
  private readonly lowWatermark: number;

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
    this.capacity = Math.max(1, Math.floor(options.capacity ?? 2_048));
    this.highWatermark = clampWatermark(options.highWatermark, 0.7);
    this.shedWatermark = Math.max(
      this.highWatermark,
      clampWatermark(options.shedWatermark, 0.9),
    );
    this.lowWatermark = Math.min(
      this.highWatermark,
      clampWatermark(options.lowWatermark, 0.5),
    );
  }

  get length(): number {
    return this.size;
  }

  get occupancy(): number {
    return this.size / this.capacity;
  }

  get pressureLevel(): PressureLevel {
    return this.pressure;
  }

  /** Offer a frame. Returns false when it was shed at admission. */
  push(frame: TelemetryFrame<T>): boolean {
    this.offered++;

    if (this.size >= this.capacity) {
      const victim = this.findEvictionVictim();
      // Should never happen (capacity > 0), but keep the invariant explicit.
      if (!victim) {
        this.rejected++;
        this.bumpDrop(frame.priority);
        this.updatePressure();
        return false;
      }

      // Never sacrifice a higher-priority frame for a lower-priority arrival.
      if (PRIORITY_RANK[frame.priority] < PRIORITY_RANK[victim.frame.priority]) {
        this.rejected++;
        this.bumpDrop(frame.priority);
        this.updatePressure();
        return false;
      }

      this.unlink(victim);
      this.evicted++;
      this.bumpDrop(victim.frame.priority);
    }

    const node: Node<T> = { frame, prev: null, next: null, active: true };
    if (this.tail) {
      this.tail.next = node;
      node.prev = this.tail;
      this.tail = node;
    } else {
      this.head = node;
      this.tail = node;
    }
    this.queues[frame.priority].push(node);
    this.size++;
    this.admitted++;
    this.updatePressure();
    return true;
  }

  /** Remove up to `max` frames in insertion order. */
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

  /** Peek at the oldest frame without removing it. */
  peek(): TelemetryFrame<T> | undefined {
    return this.head?.frame;
  }

  /** Account for frames sampled before they reached the ring. */
  recordSampled(count = 1): void {
    if (count > 0) this.sampled += count;
  }

  /** Register a pressure listener. Fires only on level transitions. */
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
    // Between low and high: keep the current level (hysteresis).

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
        // A broken observer must never take down telemetry admission.
      }
    }
  }
}

export default RingBuffer;
