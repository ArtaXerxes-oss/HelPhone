/**
 * Intelligent binary asset management for Workbox quota optimization.
 * Addresses ISP-063: Large binary asset sync vs Workbox quota vs syncManager priority inversion.
 *
 * Implements tiered caching with fallback degradation:
 *  - Tier 1: Critical assets (WASM bundles, hero video segments) → persistent cache
 *  - Tier 2: Map tiles & optimization data → memory cache with LRU eviction
 *  - Tier 3: Ephemeral renders → IndexedDB with gc on quota pressure
 */

export interface AssetMetadata {
  url: string
  size: number
  type: 'critical' | 'frequent' | 'ephemeral'
  hash: string
  ttl?: number
  priority: 0 | 1 | 2
}

export interface CacheStats {
  persistent: number
  memory: number
  indexed: number
  ephemeral?: number
  total: number
  quotaRatio?: number
  pressured: boolean
  criticalPressured?: boolean
}

const QUOTA_WARNING_THRESHOLD = 0.85
const QUOTA_CRITICAL_THRESHOLD = 0.95
const MEMORY_CACHE_MAX_ENTRIES = 50
const EPHEMERAL_TTL = 3600_000

export class AssetManager {
  private persistent: Map<string, Blob> = new Map()
  private memory: Map<string, { blob: Blob; timestamp: number }> = new Map()
  private ephemeral: Map<string, { blob: Blob; cachedAt: number; ttl: number }> = new Map()
  private metadata: Map<string, AssetMetadata> = new Map()
  private gc: AbortController | null = null
  private gcTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.initializeGC()
  }

  private initializeGC() {
    this.gc = new AbortController()
    this.gcTimer = setInterval(() => this.gcEphemeral(), 60_000)
    ;(this.gcTimer as { unref?: () => void }).unref?.()
  }

  async cacheAsset(meta: AssetMetadata, blob: Blob): Promise<{ cached: boolean; tier: string }> {
    const stats = await this.getStats()
    const meta2 = { ...meta, size: blob.size }

    if (stats.pressured) {
      if (meta.type === 'critical') {
        await this.evictUnderPressure()
      } else {
        await this.evictByPriority(meta.priority + 1)
      }
    }

    this.metadata.set(meta.url, meta2)

    switch (meta.type) {
      case 'critical':
        this.persistent.set(meta.url, blob)
        return { cached: true, tier: 'persistent' }

      case 'frequent': {
        if (this.memory.size >= MEMORY_CACHE_MAX_ENTRIES) {
          const oldest = [...this.memory.entries()].sort(([, a], [, b]) => a.timestamp - b.timestamp)[0]
          if (oldest) {
            this.memory.delete(oldest[0])
            this.metadata.delete(oldest[0])
          }
        }
        this.memory.set(meta.url, { blob, timestamp: Date.now() })
        return { cached: true, tier: 'memory' }
      }

      case 'ephemeral':
        if (stats.pressured) {
          return { cached: false, tier: 'ephemeral' }
        }
        this.ephemeral.set(meta.url, { blob, cachedAt: Date.now(), ttl: meta.ttl ?? EPHEMERAL_TTL })
        return { cached: true, tier: 'ephemeral' }
    }
  }

  async getAsset(url: string): Promise<Blob | null> {
    if (this.persistent.has(url)) return this.persistent.get(url)!
    if (this.memory.has(url)) return this.memory.get(url)!.blob
    if (this.ephemeral.has(url)) return this.ephemeral.get(url)!.blob
    return null
  }

  /**
   * Evict Tier 3 (ephemeral) first, then Tier 2 (frequent/memory).
   * Never evicts Tier 1 (critical/persistent).
   */
  async evictUnderPressure(): Promise<number> {
    let evicted = 0
    if (this.ephemeral.size > 0) {
      for (const url of [...this.ephemeral.keys()]) {
        this.ephemeral.delete(url)
        this.metadata.delete(url)
        evicted++
      }
      return evicted
    }

    const memoryCandidates = [...this.memory.entries()].sort(([, a], [, b]) => a.timestamp - b.timestamp)
    for (const [url] of memoryCandidates.slice(0, Math.max(1, Math.ceil(memoryCandidates.length / 2)))) {
      this.memory.delete(url)
      this.metadata.delete(url)
      evicted++
    }
    return evicted
  }

  private async evictByPriority(minPriority: number) {
    const candidates = [...this.metadata.entries()]
      .filter(([, m]) => m.priority >= minPriority && m.type !== 'critical')
      .sort(([, a], [, b]) => (b.priority - a.priority) || (a.ttl ?? Infinity) - (b.ttl ?? Infinity))

    for (const [url] of candidates.slice(0, 5)) {
      this.memory.delete(url)
      this.ephemeral.delete(url)
      this.metadata.delete(url)
    }
  }

  private gcEphemeral() {
    const now = Date.now()
    for (const [url, entry] of this.ephemeral) {
      if (now - entry.cachedAt > entry.ttl) {
        this.ephemeral.delete(url)
        this.metadata.delete(url)
      }
    }
  }

  private async getStats(): Promise<CacheStats> {
    let persistentSize = 0
    for (const blob of this.persistent.values()) persistentSize += blob.size
    let memorySize = 0
    for (const { blob } of this.memory.values()) memorySize += blob.size
    let ephemeralSize = 0
    for (const { blob } of this.ephemeral.values()) ephemeralSize += blob.size

    const estimate = typeof navigator !== 'undefined' ? await navigator.storage?.estimate?.() : undefined
    const usage = estimate?.usage ?? (persistentSize + memorySize + ephemeralSize)
    const quota = estimate?.quota ?? 50 * 1024 * 1024
    const ratio = quota > 0 ? usage / quota : 0

    return {
      persistent: persistentSize,
      memory: memorySize,
      indexed: Math.max(0, usage - persistentSize - memorySize),
      ephemeral: ephemeralSize,
      total: usage,
      quotaRatio: ratio,
      pressured: ratio > QUOTA_WARNING_THRESHOLD,
      criticalPressured: ratio > QUOTA_CRITICAL_THRESHOLD,
    }
  }

  async getStatsPublic(): Promise<CacheStats> {
    return this.getStats()
  }

  destroy() {
    this.gc?.abort()
    if (this.gcTimer) {
      clearInterval(this.gcTimer)
      this.gcTimer = null
    }
    this.persistent.clear()
    this.memory.clear()
    this.ephemeral.clear()
    this.metadata.clear()
  }
}
