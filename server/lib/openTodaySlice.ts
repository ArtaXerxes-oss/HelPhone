/**
 * Actionable-first slice for a device joining the mesh (docs/crdt-architecture.md §3.2).
 *
 * The device renders this before any background sync, so it must stay small:
 * unresolved incidents only, capped by row count and by serialized bytes.
 */

import type { DomainStore, Incident } from './domainStore.ts'
import { encodeGeohash } from './geo.ts'

/** Hard row cap. A join never needs more than this to render the active queue. */
export const OPEN_TODAY_LIMIT = 200
/** Payload bound from issue #929: the slice must stay under 1 MB. */
export const OPEN_TODAY_MAX_BYTES = 1_000_000

export interface OpenTodayRow {
  id: string
  status: Incident['status']
  priority: Incident['priority']
  version: number
  geohash: string
  server_received_at: string
}

export function toOpenTodayRow(incident: Incident): OpenTodayRow {
  return {
    id: incident.id,
    status: incident.status,
    priority: incident.priority,
    version: incident.version,
    geohash: encodeGeohash(incident.location.lat, incident.location.lng, 11),
    server_received_at: incident.createdAt,
  }
}

export function buildOpenTodaySlice(
  store: Pick<DomainStore, 'listActiveIncidents'>,
  { limit = OPEN_TODAY_LIMIT, maxBytes = OPEN_TODAY_MAX_BYTES } = {},
): OpenTodayRow[] {
  const rows: OpenTodayRow[] = []
  // Account for the surrounding "[" and "]".
  let bytes = 2
  for (const incident of store.listActiveIncidents(limit)) {
    const row = toOpenTodayRow(incident)
    // +1 for the comma separator between rows.
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
    if (bytes + size > maxBytes) break
    rows.push(row)
    bytes += size
  }
  return rows
}
