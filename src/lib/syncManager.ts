import { LwwElementSet, type LwwOperation } from './crdt'

export interface SyncConflict {
  conflict: true
  serverVersion: number
  mergeProposal: Record<string, unknown>
}

export interface ValidationIssue {
  path: string
  message: string
}

export type SyncOutcome<T = unknown> =
  | { status: 'ok'; snapshot: Record<string, T>; serverVersion?: number }
  | { status: 'conflict'; conflict: SyncConflict }
  | { status: 'validation'; issues: ValidationIssue[] }
  | { status: 'auth'; reason: 'unauthorized' | 'forbidden' }
  | { status: 'retry'; attempts: number; error: string }

export interface SyncManagerOptions {
  maxRetries?: number
  baseDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  onConflict?: (conflict: SyncConflict) => void
}

/**
 * Offline outbox client.
 *
 * `sync()` keeps the legacy throw-on-error behaviour. `syncWithConflict()` is
 * the contract-aware path: a 409 is a terminal, user-mergeable outcome (never
 * an infinite retry), a 422 surfaces issues, and only 5xx/network errors retry
 * with bounded exponential backoff. GraphQL union responses are understood too
 * so REST-flush and GraphQL-flush clients behave identically.
 */
export class SyncManager<T = unknown> {
  private readonly maxRetries: number
  private readonly baseDelayMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly onConflict?: (conflict: SyncConflict) => void

  constructor(
    readonly document: LwwElementSet<T>,
    readonly endpoint = '/api/sync',
    options: SyncManagerOptions = {},
  ) {
    this.maxRetries = options.maxRetries ?? 3
    this.baseDelayMs = options.baseDelayMs ?? 250
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.onConflict = options.onConflict
  }

  async sync(fetcher: typeof fetch = fetch) {
    const response = await fetcher(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.document.snapshot()),
    })
    if (!response.ok) throw new Error(`sync failed: ${response.status}`)
    const body = (await response.json()) as { operations: LwwOperation<T>[] }
    this.document.merge(body.operations)
    return this.document.snapshot()
  }

  async syncWithConflict(fetcher: typeof fetch = fetch): Promise<SyncOutcome<T>> {
    let lastError = 'sync failed'
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      try {
        const response = await fetcher(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(this.document.snapshot()),
        })

        if (response.status === 401) return { status: 'auth', reason: 'unauthorized' }
        if (response.status === 403) return { status: 'auth', reason: 'forbidden' }

        if (response.status === 409) {
          const body = (await response.json()) as Partial<SyncConflict> & {
            data?: { syncFlush?: SyncConflict }
          }
          const conflict = (body.data?.syncFlush ?? body) as SyncConflict
          this.onConflict?.(conflict)
          return { status: 'conflict', conflict }
        }

        if (response.status === 422) {
          const body = (await response.json()) as { issues?: ValidationIssue[] }
          return { status: 'validation', issues: body.issues ?? [] }
        }

        if (!response.ok) {
          lastError = `sync failed: ${response.status}`
          if (response.status < 500) return { status: 'validation', issues: [] }
          if (attempt > this.maxRetries) break;
          await this.sleep(this.baseDelayMs * 2 ** (attempt - 1))
          continue
        }

        const body = (await response.json()) as { operations?: LwwOperation<T>[]; data?: { syncFlush?: unknown } }
        if (body.data?.syncFlush) {
          return this.handleGraphQL(body.data.syncFlush as Record<string, unknown>)
        }
        if (Array.isArray(body.operations)) this.document.merge(body.operations)
        return { status: 'ok', snapshot: this.document.snapshot() }
      } catch (error) {
        lastError = String((error as Error)?.message ?? error)
        if (attempt > this.maxRetries) break
        await this.sleep(this.baseDelayMs * 2 ** (attempt - 1))
      }
    }
    return { status: 'retry', attempts: this.maxRetries + 1, error: lastError }
  }

  private handleGraphQL(result: Record<string, unknown>): SyncOutcome<T> {
    const typename = result.__typename
    if (typename === 'SyncConflict') {
      const conflict: SyncConflict = {
        conflict: true,
        serverVersion: Number(result.serverVersion) || 0,
        mergeProposal: (result.mergeProposal as Record<string, unknown>) ?? {},
      }
      this.onConflict?.(conflict)
      return { status: 'conflict', conflict }
    }
    if (typename === 'ValidationError') {
      return { status: 'validation', issues: (result.issues as ValidationIssue[]) ?? [] }
    }
    if (typename === 'SyncSuccess') {
      return {
        status: 'ok',
        snapshot: this.document.snapshot(),
        serverVersion: Number(result.serverVersion) || undefined,
      }
    }
    return { status: 'ok', snapshot: this.document.snapshot() }
  }
}
