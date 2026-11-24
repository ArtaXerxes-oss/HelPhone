import { LwwElementSet, LwwOperation } from '../lib/crdt'
import { swChannel, postToServiceWorker, getInstanceId } from '../lib/swChannel'

import type { SecureStorage } from '../lib/secureStorage'

export interface OfflineHelpRecord {
  status: string
  lat: number
  lng: number
  updatedAt: number
}

export interface ContractLifecycleEvent {
  topic: string
  ledger: number
  id: string
  tenantId?: string
}

export const helpStore = new LwwElementSet<OfflineHelpRecord>('browser')
const contractEventListeners = new Set<(event: ContractLifecycleEvent) => void>()
const recentEventIds = new Set<string>()
const recentEventOrder: string[] = []
const MAX_RECENT_EVENTS = 512
const PERSIST_KEY = 'help-store'

export const upsertOfflineHelp = (id: string, value: OfflineHelpRecord) => {
  const op = helpStore.set(id, value, value.updatedAt)
  broadcastHelpOperation(op)
  return op
}

export const removeOfflineHelp = (id: string, updatedAt = Date.now()) => {
  const op = helpStore.delete(id, updatedAt)
  broadcastHelpOperation(op)
  return op
}

function broadcastHelpOperation(op: LwwOperation<OfflineHelpRecord>) {
  const payload = { store: 'helpStore', operations: [op], vectorClock: { ...helpStore.clock } }
  swChannel.post('CRDT_SYNC', payload)
  postToServiceWorker({ type: 'CRDT_SYNC', source: getInstanceId(), payload, timestamp: Date.now() })
}

function normalizeContractEvent(value: unknown): ContractLifecycleEvent | null {
  if (!value || typeof value !== 'object') return null
  const event = value as Partial<ContractLifecycleEvent>
  if (typeof event.topic !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(event.topic)) return null
  if (!Number.isSafeInteger(event.ledger) || typeof event.id !== 'string' || event.id.length > 256) return null
  if (event.tenantId !== undefined && (typeof event.tenantId !== 'string' || event.tenantId.length > 128)) return null
  return { topic: event.topic, ledger: event.ledger as number, id: event.id, tenantId: event.tenantId }
}

function dispatchContractEvent(value: unknown) {
  const event = normalizeContractEvent(value)
  if (!event || recentEventIds.has(event.id)) return
  recentEventIds.add(event.id)
  recentEventOrder.push(event.id)
  if (recentEventOrder.length > MAX_RECENT_EVENTS) {
    recentEventIds.delete(recentEventOrder.shift()!)
  }
  for (const listener of [...contractEventListeners]) {
    try {
      listener(event)
    } catch (error) {
      console.warn('[helpStore] contract-event listener failed:', error)
    }
  }
}

export function subscribeToContractLifecycleEvents(listener: (event: ContractLifecycleEvent) => void) {
  contractEventListeners.add(listener)
  return () => contractEventListeners.delete(listener)
}

/** Subscribe to CRDT updates and the leader's Redis/SSE contract-event fanout. */
export function initHelpStoreChannelSync(): () => void {
  const applyToStore = (payload: any) => {
    if (!payload || payload.store !== 'helpStore' || !Array.isArray(payload.operations)) return
    for (const op of payload.operations) helpStore.apply(op)
  }
  const onMessage = (message: any) => {
    if (message?.type === 'CRDT_SYNC') applyToStore(message.payload)
    if (message?.type === 'CONTRACT_EVENT') dispatchContractEvent(message.payload)
  }
  const unsubChannel = swChannel.subscribe(onMessage)
  const unsubSw = subscribeToServiceWorkerMessages(onMessage)
  return () => {
    unsubChannel()
    unsubSw()
  }
}

function subscribeToServiceWorkerMessages(handler: (message: any) => void): () => void {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return () => {}
  const listener = (event: MessageEvent) => handler(event.data)
  navigator.serviceWorker.addEventListener('message', listener)
  return () => navigator.serviceWorker.removeEventListener('message', listener)
}

export async function persistHelpStore(storage: SecureStorage, store = helpStore) {
  const { operations, entries } = store.snapshot()
  await storage.setItem(PERSIST_KEY, JSON.stringify([...operations, ...entries]))
}

export async function hydrateHelpStore(storage: SecureStorage, store = helpStore) {
  const raw = await storage.getItem(PERSIST_KEY)
  if (raw === null) return false
  store.merge(JSON.parse(raw) as LwwOperation<OfflineHelpRecord>[])
  return true
}
