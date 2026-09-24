import { LwwElementSet } from '../lib/crdt'
export interface OfflineHelpRecord { status: string; lat: number; lng: number; updatedAt: number }
export const helpStore = new LwwElementSet<OfflineHelpRecord>('browser')
export const upsertOfflineHelp = (id: string, value: OfflineHelpRecord) => helpStore.set(id, value, value.updatedAt)
export const removeOfflineHelp = (id: string, updatedAt = Date.now()) => helpStore.delete(id, updatedAt)
