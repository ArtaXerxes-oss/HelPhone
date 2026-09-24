import { LwwElementSet, type LwwOperation } from './crdt'
export class SyncManager<T = unknown> {
  constructor(readonly document: LwwElementSet<T>, readonly endpoint = '/api/sync') {}
  async sync(fetcher: typeof fetch = fetch) {
    const response = await fetcher(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.document.snapshot()) })
    if (!response.ok) throw new Error(`sync failed: ${response.status}`)
    const body = await response.json() as { operations: LwwOperation<T>[] }
    this.document.merge(body.operations)
    return this.document.snapshot()
  }
}
