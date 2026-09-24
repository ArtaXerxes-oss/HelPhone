export type VectorClock = Record<string, number>
export interface LwwOperation<T = unknown> { key: string; value?: T; deleted: boolean; actor: string; counter: number; timestamp: number }
const wins = (a: LwwOperation, b: LwwOperation) => a.timestamp > b.timestamp || (a.timestamp === b.timestamp && (a.counter > b.counter || (a.counter === b.counter && a.actor > b.actor)))
export class LwwElementSet<T = unknown> {
  readonly actor: string
  readonly clock: VectorClock = {}
  private entries = new Map<string, LwwOperation<T>>()
  private operations = new Map<string, LwwOperation<T>>()
  constructor(actor: string) { this.actor = actor }
  set(key: string, value: T, timestamp = Date.now()) { return this.local(key, value, false, timestamp) }
  delete(key: string, timestamp = Date.now()) { return this.local(key, undefined, true, timestamp) }
  private local(key: string, value: T | undefined, deleted: boolean, timestamp: number) {
    const operation = { key, value, deleted, actor: this.actor, counter: (this.clock[this.actor] ?? 0) + 1, timestamp }
    this.apply(operation)
    return operation
  }
  apply(operation: LwwOperation<T>) {
    const id = `${operation.actor}:${operation.counter}`
    if (this.operations.has(id)) return false
    this.operations.set(id, operation)
    this.clock[operation.actor] = Math.max(this.clock[operation.actor] ?? 0, operation.counter)
    const current = this.entries.get(operation.key)
    if (!current || wins(operation, current)) this.entries.set(operation.key, operation)
    return true
  }
  merge(operations: Iterable<LwwOperation<T>>) { for (const operation of operations) this.apply(operation) }
  values() { return [...this.entries.values()].filter((entry) => !entry.deleted).map(({ key, value }) => [key, value] as const) }
  delta(remote: VectorClock) { return [...this.operations.values()].filter((op) => op.counter > (remote[op.actor] ?? 0)) }
  prune(stable: VectorClock) {
    let removed = 0
    for (const [id, op] of this.operations) {
      if (op.counter <= (stable[op.actor] ?? 0) && this.entries.get(op.key) !== op) { this.operations.delete(id); removed++ }
    }
    for (const [key, op] of this.entries) {
      if (op.deleted && op.counter <= (stable[op.actor] ?? 0)) { this.entries.delete(key); this.operations.delete(`${op.actor}:${op.counter}`); removed++ }
    }
    return removed
  }
  snapshot() { return { clock: { ...this.clock }, operations: [...this.operations.values()], entries: [...this.entries.values()].sort((a, b) => a.key.localeCompare(b.key)) } }
  get storageBytes() { return new TextEncoder().encode(JSON.stringify(this.snapshot())).byteLength }
}
export function stableVector(vectors: VectorClock[]): VectorClock {
  const actors = new Set(vectors.flatMap((v) => Object.keys(v)))
  return Object.fromEntries([...actors].map((actor) => [actor, Math.min(...vectors.map((v) => v[actor] ?? 0))]))
}
