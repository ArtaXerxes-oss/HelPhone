export type VectorClock = Record<string, number>

export interface LwwOperation<T = unknown> {
  key: string
  value?: T
  deleted: boolean
  actor: string
  counter: number
  timestamp: number
  instance?: string
  provenance?: 'local' | 'peer_asserted'
  winnerAnnotation?: string
}

export const STATUS_LATTICE_RANK: Record<string, number> = {
  cancelled: 5,
  open: 10,
  assigned: 20,
  in_progress: 30,
  resolved: 40,
  escalated: 50,
  critical: 55,
}

export const PRIORITY_LATTICE_RANK: Record<string, number> = {
  low: 10,
  medium: 20,
  high: 30,
  critical: 40,
}

/**
 * Deterministic cross-domain conflict resolution.
 * Applies safety lattices for status and priority, then falls back to total order:
 * timestamp > counter > instance > actor.
 */
export function evaluateConflictWinner(a: LwwOperation, b: LwwOperation): { winner: LwwOperation; annotation: string } {
  const aVal = a.value as Record<string, unknown> | undefined
  const bVal = b.value as Record<string, unknown> | undefined

  if (aVal && bVal && typeof aVal === 'object' && typeof bVal === 'object') {
    // 1. Status Safety Lattice
    const aStatus = typeof aVal.status === 'string' ? aVal.status.toLowerCase() : null
    const bStatus = typeof bVal.status === 'string' ? bVal.status.toLowerCase() : null
    if (aStatus && bStatus && aStatus !== bStatus) {
      const aRank = STATUS_LATTICE_RANK[aStatus] ?? 0
      const bRank = STATUS_LATTICE_RANK[bStatus] ?? 0
      if (aRank !== bRank) {
        return aRank > bRank
          ? { winner: a, annotation: `lattice:status_${aStatus}_over_${bStatus}` }
          : { winner: b, annotation: `lattice:status_${bStatus}_over_${aStatus}` }
      }
    }

    // 2. Priority Safety Lattice
    const aPri = typeof aVal.priority === 'string' ? aVal.priority.toLowerCase() : null
    const bPri = typeof bVal.priority === 'string' ? bVal.priority.toLowerCase() : null
    if (aPri && bPri && aPri !== bPri) {
      const aRank = PRIORITY_LATTICE_RANK[aPri] ?? 0
      const bRank = PRIORITY_LATTICE_RANK[bPri] ?? 0
      if (aRank !== bRank) {
        return aRank > bRank
          ? { winner: a, annotation: `lattice:priority_${aPri}_over_${bPri}` }
          : { winner: b, annotation: `lattice:priority_${bPri}_over_${aPri}` }
      }
    }
  }

  // 3. Fallback deterministic total ordering:
  // timestamp > counter > instance > actor
  if (a.timestamp !== b.timestamp) {
    return a.timestamp > b.timestamp
      ? { winner: a, annotation: 'lww:timestamp' }
      : { winner: b, annotation: 'lww:timestamp' }
  }
  if (a.counter !== b.counter) {
    return a.counter > b.counter
      ? { winner: a, annotation: 'tiebreaker:counter' }
      : { winner: b, annotation: 'tiebreaker:counter' }
  }
  const aInst = a.instance || ''
  const bInst = b.instance || ''
  if (aInst !== bInst) {
    return aInst > bInst
      ? { winner: a, annotation: `tiebreaker:instance_${aInst}` }
      : { winner: b, annotation: `tiebreaker:instance_${bInst}` }
  }
  return a.actor >= b.actor
    ? { winner: a, annotation: `tiebreaker:actor_${a.actor}` }
    : { winner: b, annotation: `tiebreaker:actor_${b.actor}` }
}

export const wins = (a: LwwOperation, b: LwwOperation): boolean => {
  return evaluateConflictWinner(a, b).winner === a
}

export class LwwElementSet<T = unknown> {
  readonly actor: string
  readonly instance: string
  readonly clock: VectorClock = {}
  private entries = new Map<string, LwwOperation<T>>()
  private operations = new Map<string, LwwOperation<T>>()

  constructor(actor: string, instance = 'local') {
    this.actor = actor
    this.instance = instance
  }

  set(key: string, value: T, timestamp = Date.now()) {
    return this.local(key, value, false, timestamp)
  }

  delete(key: string, timestamp = Date.now()) {
    return this.local(key, undefined, true, timestamp)
  }

  private local(key: string, value: T | undefined, deleted: boolean, timestamp: number) {
    const clockKey = this.actor
    const counter = (this.clock[clockKey] ?? 0) + 1
    const operation: LwwOperation<T> = {
      key,
      value,
      deleted,
      actor: this.actor,
      instance: this.instance,
      counter,
      timestamp,
      provenance: this.instance === 'local' ? 'local' : 'peer_asserted',
    }
    this.apply(operation)
    return operation
  }

  apply(operation: LwwOperation<T>) {
    const id = operation.instance
      ? `${operation.instance}:${operation.actor}:${operation.counter}`
      : `${operation.actor}:${operation.counter}`

    if (this.operations.has(id)) return false
    this.operations.set(id, operation)

    const clockKey = operation.actor
    this.clock[clockKey] = Math.max(this.clock[clockKey] ?? 0, operation.counter)
    if (operation.instance && operation.instance !== 'local') {
      const federatedKey = `${operation.instance}:${operation.actor}`
      this.clock[federatedKey] = Math.max(this.clock[federatedKey] ?? 0, operation.counter)
    }

    const current = this.entries.get(operation.key)
    if (!current) {
      this.entries.set(operation.key, operation)
    } else {
      const { winner, annotation } = evaluateConflictWinner(operation, current)
      const annotated = { ...winner, winnerAnnotation: annotation }
      this.entries.set(operation.key, annotated as LwwOperation<T>)
    }
    return true
  }

  merge(operations: Iterable<LwwOperation<T>>) {
    for (const operation of operations) this.apply(operation)
  }

  values() {
    return [...this.entries.values()]
      .filter((entry) => !entry.deleted)
      .map(({ key, value }) => [key, value] as const)
  }

  delta(remote: VectorClock) {
    return [...this.operations.values()].filter((op) => {
      const remoteCounter = remote[op.actor] ?? (op.instance ? remote[`${op.instance}:${op.actor}`] ?? 0 : 0)
      return op.counter > remoteCounter
    })
  }

  prune(stable: VectorClock) {
    let removed = 0
    for (const [id, op] of this.operations) {
      const stableCounter = stable[op.actor] ?? (op.instance ? stable[`${op.instance}:${op.actor}`] ?? 0 : 0)
      if (op.counter <= stableCounter && this.entries.get(op.key) !== op) {
        this.operations.delete(id)
        removed++
      }
    }
    for (const [key, op] of this.entries) {
      const stableCounter = stable[op.actor] ?? (op.instance ? stable[`${op.instance}:${op.actor}`] ?? 0 : 0)
      const id = op.instance ? `${op.instance}:${op.actor}:${op.counter}` : `${op.actor}:${op.counter}`
      if (op.deleted && op.counter <= stableCounter) {
        this.entries.delete(key)
        this.operations.delete(id)
        removed++
      }
    }
    return removed
  }

  snapshot(journalHighwater = 0) {
    return {
      clock: { ...this.clock },
      journal_highwater: journalHighwater,
      operations: [...this.operations.values()],
      entries: [...this.entries.values()].sort((a, b) => a.key.localeCompare(b.key)),
    }
  }

  get storageBytes() {
    return new TextEncoder().encode(JSON.stringify(this.snapshot())).byteLength
  }
}

export function stableVector(vectors: VectorClock[]): VectorClock {
  const actors = new Set(vectors.flatMap((v) => Object.keys(v)))
  return Object.fromEntries([...actors].map((actor) => [actor, Math.min(...vectors.map((v) => v[actor] ?? 0))]))
}
