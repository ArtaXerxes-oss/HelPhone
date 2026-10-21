import { LwwElementSet, type LwwOperation } from './crdt'
import { waitForRecovery, isRecoveryComplete } from './crashRecovery'
import { SqliteBusyError } from '../services/storageEngine'

export class SyncManager<T = unknown> {
  private idbOutbox: any[] = []

  constructor(
    readonly document: LwwElementSet<T>,
    readonly endpoint = '/api/sync',
    readonly journalStore: any = null,
    readonly storageEngine: any = null
  ) {}

  /**
   * Dispatch insert lane:
   * Single commit order: SQLite WAL commit -> OPFS syncfs -> IDB mark acked.
   * Under SQLITE_BUSY, falls back to IDB outbox so dispatch is never lost.
   */
  async dispatch(op: { device_id: string; seq: number; [key: string]: any }): Promise<{ stored: boolean; outbox: boolean }> {
    if (this.storageEngine) {
      try {
        await this.storageEngine.appendBatch('dispatches', [op], { lane: 'dispatch' })
        if (this.journalStore) {
          this.journalStore.append(op.device_id, op.seq, op)
          this.journalStore.markAcked(op.device_id, op.seq)
        }
        return { stored: true, outbox: false }
      } catch (err) {
        if (err instanceof SqliteBusyError || (err && (err as any).name === 'SqliteBusyError')) {
          if (this.journalStore) {
            this.journalStore.append(op.device_id, op.seq, op)
          } else {
            this.idbOutbox.push(op)
          }
          return { stored: false, outbox: true }
        }
        throw err
      }
    }

    if (this.journalStore) {
      this.journalStore.append(op.device_id, op.seq, op)
    } else {
      this.idbOutbox.push(op)
    }
    return { stored: true, outbox: false }
  }

  async sync(fetcher: typeof fetch = fetch) {
    // Upload gate: waits until crash recovery completes (no upload of uncheckpointed state)
    await waitForRecovery()

    const response = await fetcher(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.document.snapshot()),
    })
    if (!response.ok) throw new Error(`sync failed: ${response.status}`)
    const body = (await response.json()) as { operations: LwwOperation<T>[]; deduped?: boolean }
    if (body.operations) {
      this.document.merge(body.operations)
    }
    return this.document.snapshot()
  }

  getOutbox(): any[] {
    return [...this.idbOutbox]
  }

  clearOutbox(): void {
    this.idbOutbox = []
  }
}

