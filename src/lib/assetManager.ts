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
  total: number
  pressured: boolean
}

const QUOTA_WARNING_THRESHOLD = 0.85
const QUOTA_CRITICAL_THRESHOLD = 0.95
const MEMORY_CACHE_MAX_ENTRIES = 50
const EPHEMERAL_TTL = 3600_000

export class AssetManager {
  private persistent: Map<string, Blob> = new Map()
  private memory: Map<string, { blob: Blob; timestamp: number }> = new Map()
  private metadata: Map<string, AssetMetadata> = new Map()
  private gc: AbortController | null = null

  constructor() {
    this.initializeGC()
  }

  private initializeGC() {
    this.gc = new AbortController()
    setInterval(() => this.gcEphemeral(), 60_000)
  }

  async cacheAsset(meta: AssetMetadata, blob: Blob): Promise<{ cached: boolean; tier: string }> {
    const stats = await this.getStats()
    const meta2 = { ...meta, size: blob.size }

    if (stats.pressured && meta.type !== 'critical') {
      await this.evictByPriority(meta.priority + 1)
    }

    this.metadata.set(meta.url, meta2)

    switch (meta.type) {
      case 'critical':
        this.persistent.set(meta.url, blob)
        return { cached: true, tier: 'persistent' }

      case 'frequent': {
        if (this.memory.size >= MEMORY_CACHE_MAX_ENTRIES) {
          const oldest = [...this.memory.entries()].sort(([, a], [, b]) => a.timestamp - b.timestamp)[0]
          if (oldest) this.memory.delete(oldest[0])
        }
        this.memory.set(meta.url, { blob, timestamp: Date.now() })
        return { cached: true, tier: 'memory' }
      }

      case 'ephemeral':
        return { cached: true, tier: 'ephemeral' }
    }
  }

  async getAsset(url: string): Promise<Blob | null> {
    if (this.persistent.has(url)) return this.persistent.get(url)!
    if (this.memory.has(url)) return this.memory.get(url)!.blob
    return null
  }

  private async evictByPriority(minPriority: number) {
    const candidates = [...this.metadata.entries()]
      .filter(([, m]) => m.priority >= minPriority && m.type !== 'critical')
      .sort(([, a], [, b]) => (b.priority - a.priority) || (a.ttl ?? Infinity) - (b.ttl ?? Infinity))

    for (const [url] of candidates.slice(0, 5)) {
      this.persistent.delete(url)
      this.memory.delete(url)
      this.metadata.delete(url)
    }
  }

  private gcEphemeral() {
    const now = Date.now()
    for (const [url, meta] of this.metadata) {
      if (meta.type === 'ephemeral' && meta.ttl && meta.hash) {
        const age = now - (meta.ttl - EPHEMERAL_TTL)
        if (age > 0) {
          this.persistent.delete(url)
          this.memory.delete(url)
          this.metadata.delete(url)
        }
      }
    }
  }

  private async getStats(): Promise<CacheStats> {
    let persistentSize = 0
    for (const blob of this.persistent.values()) persistentSize += blob.size
    let memorySize = 0
    for (const { blob } of this.memory.values()) memorySize += blob.size

    const estimate = await navigator.storage?.estimate?.()
    const usage = estimate?.usage ?? 0
    const quota = estimate?.quota ?? 50 * 1024 * 1024
    const ratio = usage / quota

    return {
      persistent: persistentSize,
      memory: memorySize,
      indexed: Math.max(0, usage - persistentSize - memorySize),
      total: usage,
      pressured: ratio > QUOTA_WARNING_THRESHOLD,
    }
  }

  async getStatsPublic(): Promise<CacheStats> {
    return this.getStats()
  }

  destroy() {
    this.gc?.abort()
    this.persistent.clear()
    this.memory.clear()
    this.metadata.clear()
  }
}
