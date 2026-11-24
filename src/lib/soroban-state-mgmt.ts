/**
 * Soroban state bloat economics management (Issue #755)
 * Handles footprint growth vs archive TTL vs maintainer_vault rent subsidy
 */

import { trackSorobanState } from './telemetry'

export interface StateMetrics {
  totalSize: number
  entryCount: number
  archiveAge: number
  rentBalance: number
  footprintGrowthRate: number // bytes/transaction
}

interface StateEntry {
  key: string
  size: number
  createdAt: number
  lastAccessAt: number
  accessCount: number
}

/**
 * Soroban state management with rent subsidy tracking
 */
export class SorobanStateManager {
  private entries = new Map<string, StateEntry>()
  private metrics: StateMetrics = {
    totalSize: 0,
    entryCount: 0,
    archiveAge: 0,
    rentBalance: 0,
    footprintGrowthRate: 0,
  }

  private readonly MAX_STATE_SIZE = 1024 * 1024 // 1MB soft limit
  private readonly ARCHIVE_TTL_DAYS = 180
  private readonly RENT_WARNING_THRESHOLD = 0.3 // Warn at 30% depletion

  async readState(key: string): Promise<unknown> {
    const startTime = Date.now()

    try {
      const entry = this.entries.get(key)
      if (entry) {
        entry.lastAccessAt = Date.now()
        entry.accessCount++
      }

      trackSorobanState('read', entry?.size || 0, Date.now() - startTime)
      return entry?.value
    } catch (error) {
      throw error
    }
  }

  async writeState(key: string, value: unknown, size: number): Promise<void> {
    const startTime = Date.now()

    try {
      const entry = this.entries.get(key)

      if (entry) {
        // Update existing entry
        this.metrics.totalSize -= entry.size
      } else {
        // New entry - check growth
        this.checkGrowth(size)
      }

      // Add new entry
      this.entries.set(key, {
        key,
        size,
        createdAt: Date.now(),
        lastAccessAt: Date.now(),
        accessCount: 0,
      })

      this.metrics.totalSize += size
      this.metrics.entryCount = this.entries.size

      trackSorobanState('write', size, Date.now() - startTime)

      // Check if cleanup needed
      if (this.metrics.totalSize > this.MAX_STATE_SIZE) {
        await this.performCleanup()
      }
    } catch (error) {
      throw error
    }
  }

  async deleteState(key: string): Promise<void> {
    const startTime = Date.now()
    const entry = this.entries.get(key)

    if (entry) {
      this.metrics.totalSize -= entry.size
      this.entries.delete(key)
      this.metrics.entryCount = this.entries.size
      trackSorobanState('delete', entry.size, Date.now() - startTime)
    }
  }

  /**
   * Check footprint growth rate and warn if excessive
   */
  private checkGrowth(newSize: number): void {
    // Estimate growth rate (bytes per second)
    const growthRate = newSize // Simplified - track actual rate in production
    this.metrics.footprintGrowthRate = growthRate

    if (growthRate > 10000) { // More than 10KB per write
      console.warn('[Soroban] High footprint growth rate detected:', growthRate)
    }
  }

  /**
   * Perform cleanup when state exceeds limit
   * Strategy: Remove old, infrequently accessed entries
   */
  private async performCleanup(): Promise<void> {
    const now = Date.now()
    const archiveTtlMs = this.ARCHIVE_TTL_DAYS * 24 * 60 * 60 * 1000

    // Collect candidates for deletion
    const candidates = Array.from(this.entries.values())
      .filter((entry) => {
        // Remove entries older than archive TTL
        const age = now - entry.createdAt
        return age > archiveTtlMs
      })
      .sort((a, b) => {
        // Sort by least recently accessed
        return a.lastAccessAt - b.lastAccessAt
      })

    // Delete until under limit
    let freed = 0
    for (const entry of candidates) {
      if (this.metrics.totalSize <= this.MAX_STATE_SIZE * 0.8) {
        break
      }

      await this.deleteState(entry.key)
      freed += entry.size
    }

    console.log(`[Soroban] Cleanup freed ${freed} bytes, total size: ${this.metrics.totalSize}`)
  }

  /**
   * Check maintainer vault rent subsidy status
   * Issues warning if subsidy running dry
   */
  checkRentSubsidy(currentRentBalance: number, monthlyBurnRate: number): void {
    this.metrics.rentBalance = currentRentBalance
    const monthsRemaining = currentRentBalance / monthlyBurnRate

    if (monthsRemaining < 3) {
      console.warn(
        `[Soroban] Rent subsidy depleting: ${monthsRemaining.toFixed(1)} months remaining`
      )
    }

    if (this.metrics.rentBalance / (this.metrics.rentBalance + monthlyBurnRate) <
        this.RENT_WARNING_THRESHOLD
    ) {
      console.error('[Soroban] CRITICAL: Rent subsidy running dry mid-disaster!')
    }
  }

  /**
   * Get current state metrics for monitoring
   */
  getMetrics(): StateMetrics {
    return {
      ...this.metrics,
      archiveAge: Math.max(
        ...Array.from(this.entries.values()).map((e) => Date.now() - e.createdAt)
      ),
    }
  }

  /**
   * Estimate storage cost based on current footprint
   */
  estimateStorageCost(costPerMB: number): number {
    return (this.metrics.totalSize / (1024 * 1024)) * costPerMB
  }
}

export const sorobanStateManager = new SorobanStateManager()
