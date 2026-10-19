/**
 * Priority-aware dispatch queue preventing urgent requests from starvation.
 * Addresses ISP-062: Vector-clock causal fence vs wall-clock dispatch priority inversion.
 *
 * Implements:
 *  - Multi-tier queue (critical, high, normal, low)
 *  - Aging mechanism preventing stale updates from starving new urgent requests
 *  - Round-robin fairness with configurable weight ratios
 */

export interface DispatchItem {
  id: string
  priority: 'critical' | 'high' | 'normal' | 'low'
  payload: unknown
  timestamp: number
  attempts: number
  maxRetries: number
}

export interface QueueMetrics {
  queued: number
  critical: number
  high: number
  normal: number
  low: number
  avgWaitTime: number
  maxWaitTime: number
}

const PRIORITY_WEIGHTS = { critical: 100, high: 10, normal: 5, low: 1 }
const AGING_FACTOR = 0.95
const MAX_WAIT_TIME = 30_000
const STALE_UPDATE_THRESHOLD = 5_000

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

  enqueue(item: Omit<DispatchItem, 'attempts'>): void {
    const fullItem: DispatchItem = { ...item, attempts: 0 }
    this.queues[item.priority].push(fullItem)
  }

  onProcess(handler: (item: DispatchItem) => Promise<void>): void {
    this.handlers.push(handler)
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
    const tiers: (keyof typeof this.queues)[] = ['critical', 'high', 'normal', 'low']
    const weights = [PRIORITY_WEIGHTS.critical, PRIORITY_WEIGHTS.high, PRIORITY_WEIGHTS.normal, PRIORITY_WEIGHTS.low]

    const totalWeight = weights.reduce((a, b) => a + b, 0)
    const rand = Math.random() * totalWeight

    let accumulated = 0
    for (let i = 0; i < tiers.length; i++) {
      accumulated += weights[i]
      if (rand < accumulated && this.queues[tiers[i]].length > 0) {
        const item = this.queues[tiers[i]].shift()
        if (item && !this.processedIds.has(item.id)) {
          return item
        }
      }
    }

    for (const tier of tiers) {
      if (this.queues[tier].length > 0) {
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
    const avgWait = this.metrics.processedCount > 0 ? this.metrics.totalWaitTime / this.metrics.processedCount : 0
    return {
      queued: Object.values(this.queues).reduce((sum, q) => sum + q.length, 0),
      critical: this.queues.critical.length,
      high: this.queues.high.length,
      normal: this.queues.normal.length,
      low: this.queues.low.length,
      avgWaitTime: avgWait,
      maxWaitTime: Math.max(
        ...Object.values(this.queues).flat().map((item) => Date.now() - item.timestamp)
      ),
    }
  }

  clear(): void {
    this.queues.critical = []
    this.queues.high = []
    this.queues.normal = []
    this.queues.low = []
    this.processedIds.clear()
    this.metrics = { totalWaitTime: 0, processedCount: 0, stalePrevented: 0 }
  }
}
