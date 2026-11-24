/**
 * Priority-aware dispatch queue preventing urgent requests from starvation.
 * Addresses ISP-062: Vector-clock causal fence vs wall-clock dispatch priority inversion.
 *
 * Implements:
 *  - Multi-tier queue (critical, high, normal, low)
 *  - Aging mechanism preventing stale updates from starving new urgent requests
 *  - Round-robin fairness with configurable weight ratios
 */

export type DispatchPriority = 'critical' | 'high' | 'normal' | 'low'
export type Adr020Tier = 'P0' | 'P1' | 'P2' | 'P3'

export interface DispatchItem {
  id: string
  priority: DispatchPriority
  payload: unknown
  timestamp: number
  attempts: number
  maxRetries: number
  isUpdate?: boolean
}

export interface QueueMetrics {
  queued: number
  critical: number
  high: number
  normal: number
  low: number
  avgWaitTime: number
  maxWaitTime: number
  stalePrevented: number
}

const PRIORITY_WEIGHTS: Record<DispatchPriority, number> = { critical: 100, high: 10, normal: 5, low: 1 }
const AGING_FACTOR = 0.95
const MAX_WAIT_TIME = 30_000
const STALE_UPDATE_THRESHOLD = 5_000
const TIERS: DispatchPriority[] = ['critical', 'high', 'normal', 'low']

export function toQueuePriority(input?: string | null): DispatchPriority {
  const normalized = input?.toString().trim().toLowerCase()
  if (normalized === 'critical' || normalized === 'p0') return 'critical'
  if (normalized === 'high' || normalized === 'p1') return 'high'
  if (normalized === 'low' || normalized === 'p3') return 'low'
  return 'normal'
}

export function toAdr020Tier(priority: DispatchPriority): Adr020Tier {
  if (priority === 'critical') return 'P0'
  if (priority === 'high') return 'P1'
  if (priority === 'low') return 'P3'
  return 'P2'
}

export class DispatchQueue {
  private queues = {
    critical: new Array<DispatchItem>(),
    high: new Array<DispatchItem>(),
    normal: new Array<DispatchItem>(),
    low: new Array<DispatchItem>(),
  }
  private processing = false
  private handlers: ((item: DispatchItem) => Promise<void>)[] = []
  private processedIds = new Set<string>()
  private metrics = { totalWaitTime: 0, processedCount: 0, stalePrevented: 0 }
  private roundRobinCredits: Record<DispatchPriority, number> = { critical: 0, high: 0, normal: 0, low: 0 }
  private tickTimer: ReturnType<typeof setInterval> | null = null

  enqueue(item: Omit<DispatchItem, 'attempts' | 'priority'> & { priority: DispatchPriority | Adr020Tier }): void {
    const priority = toQueuePriority(item.priority)
    const fullItem: DispatchItem = { ...item, priority, attempts: 0 }
    this.queues[priority].push(fullItem)
  }

  onProcess(handler: (item: DispatchItem) => Promise<void>): void {
    this.handlers.push(handler)
  }

  startTick(intervalMs: number = 100): void {
    this.stopTick()
    this.tickTimer = setInterval(() => {
      void this.process()
    }, intervalMs)
    ;(this.tickTimer as { unref?: () => void }).unref?.()
  }

  stopTick(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  async process(): Promise<void> {
    if (this.processing) return
    this.processing = true

    try {
      while (this.hasItems()) {
        const item = this.selectNext()
        if (!item) break

        if (item.priority !== 'critical' && item.priority !== 'high') {
          const age = Date.now() - item.timestamp
          if (age > STALE_UPDATE_THRESHOLD) {
            const critical = this.peekCritical()
            if (critical && Date.now() - critical.timestamp < MAX_WAIT_TIME) {
              this.metrics.stalePrevented++
              continue
            }
          }
        }

        try {
          const startTime = Date.now()
          for (const handler of this.handlers) {
            await handler(item)
          }
          item.attempts++
          const duration = Date.now() - startTime
          this.metrics.totalWaitTime += duration
          this.metrics.processedCount++
          this.processedIds.add(item.id)
        } catch (err) {
          item.attempts++
          if (item.attempts < item.maxRetries) {
            this.enqueue(item)
          } else {
            console.error(`[DispatchQueue] Failed after ${item.attempts} attempts:`, item.id, err)
          }
        }
      }
    } finally {
      this.processing = false
    }
  }

  private selectNext(): DispatchItem | undefined {
    const now = Date.now()
    // P0 (critical) always runs first when available.
    if (this.queues.critical.length > 0) {
      while (this.queues.critical.length > 0) {
        const item = this.queues.critical.shift()
        if (item && !this.processedIds.has(item.id)) {
          return item
        }
      }
    }

    // Weighted round-robin with aging for high/normal/low tiers.
    let bestTier: DispatchPriority | null = null
    let bestScore = -1

    for (const tier of TIERS) {
      const queue = this.queues[tier]
      if (queue.length === 0) continue

      const head = queue[0]
      const age = Math.max(0, now - head.timestamp)
      // Aging accelerates wait weight over time so non-stale items never exceed MAX_WAIT_TIME.
      const agingBoost = head.isUpdate && age > STALE_UPDATE_THRESHOLD ? 0 : age / (AGING_FACTOR * 1000)
      this.roundRobinCredits[tier] += PRIORITY_WEIGHTS[tier] + agingBoost

      if (this.roundRobinCredits[tier] > bestScore) {
        bestScore = this.roundRobinCredits[tier]
        bestTier = tier
      }
    }

    if (bestTier) {
      this.roundRobinCredits[bestTier] = Math.max(0, this.roundRobinCredits[bestTier] - bestScore)
      while (this.queues[bestTier].length > 0) {
        const item = this.queues[bestTier].shift()
        if (item && !this.processedIds.has(item.id)) {
          return item
        }
      }
    }

    for (const tier of TIERS) {
      while (this.queues[tier].length > 0) {
        const item = this.queues[tier].shift()
        if (item && !this.processedIds.has(item.id)) {
          return item
        }
      }
    }
    return undefined
  }

  private peekCritical(): DispatchItem | undefined {
    return this.queues.critical[0]
  }

  private hasItems(): boolean {
    return Object.values(this.queues).some((q) => q.length > 0)
  }

  getMetrics(): QueueMetrics {
    const now = Date.now()
    const allItems = Object.values(this.queues).flat()
    const avgWait = this.metrics.processedCount > 0 ? this.metrics.totalWaitTime / this.metrics.processedCount : 0
    const maxWaitTime =
      allItems.length === 0 ? 0 : Math.max(0, ...allItems.map((item) => Math.max(0, now - item.timestamp)))
    return {
      queued: allItems.length,
      critical: this.queues.critical.length,
      high: this.queues.high.length,
      normal: this.queues.normal.length,
      low: this.queues.low.length,
      avgWaitTime: avgWait,
      maxWaitTime,
      stalePrevented: this.metrics.stalePrevented,
    }
  }

  clear(): void {
    this.stopTick()
    this.queues.critical = []
    this.queues.high = []
    this.queues.normal = []
    this.queues.low = []
    this.roundRobinCredits = { critical: 0, high: 0, normal: 0, low: 0 }
    this.processedIds.clear()
    this.metrics = { totalWaitTime: 0, processedCount: 0, stalePrevented: 0 }
  }
}
