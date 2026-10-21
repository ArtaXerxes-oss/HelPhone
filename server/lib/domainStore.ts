/**
 * Canonical in-memory domain store for the dispatch/events/sync contract.
 *
 * This is the single read/write path used by both REST and GraphQL. It counts
 * every query so tests can prove batching (GraphQL incident + 40 responders
 * must issue ≤4 store queries, vs the old 1+N+N fan-out).
 *
 * A production adapter can implement the same interface over pg; keeping the
 * store behind methods is what makes the equivalence tests deterministic.
 */

export type IncidentStatus = 'open' | 'assigned' | 'acknowledged' | 'resolved';
export type Priority = 'low' | 'normal' | 'high' | 'critical';
export type ResponderStatus = 'assigned' | 'en_route' | 'on_scene' | 'offline';

export interface Location {
  lat: number;
  lng: number;
}

export interface Incident {
  id: string;
  status: IncidentStatus;
  priority: Priority;
  createdAt: string;
  version: number;
  location: Location;
}

export interface Responder {
  id: string;
  incidentId: string;
  name: string;
  status: ResponderStatus;
  location: Location;
}

export interface DomainEvent {
  id: string;
  incidentId: string;
  responderId: string | null;
  type: string;
  at: string;
  cursor: string;
  payload: Record<string, unknown>;
}

export interface ResponderWithLastEvent extends Responder {
  lastEvent: DomainEvent | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasNextPage: boolean;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export type SyncFlushResult =
  | { __typename: 'SyncSuccess'; ok: true; serverVersion: number; incident: Incident }
  | { __typename: 'SyncConflict'; conflict: true; serverVersion: number; mergeProposal: Record<string, unknown> }
  | { __typename: 'ValidationError'; error: string; issues: ValidationIssue[] };

const nowIso = () => new Date().toISOString();

let cursorSeq = 0;
function nextCursor(): string {
  cursorSeq += 1;
  return `c${cursorSeq.toString(36).padStart(6, '0')}`;
}

export class DomainStore {
  private incidents = new Map<string, Incident>();
  private responders = new Map<string, Responder>();
  private events: DomainEvent[] = [];
  private queryCount = 0;

  constructor(options: { seed?: boolean } = {}) {
    if (options.seed !== false) this.seed();
  }

  /** Seed one incident with 40 responders + events, matching the issue repro. */
  seed(): void {
    this.incidents.clear();
    this.responders.clear();
    this.events = [];
    cursorSeq = 0;

    const incident: Incident = {
      id: 'INC-1042',
      status: 'assigned',
      priority: 'critical',
      createdAt: '2026-10-21T08:00:00.000Z',
      version: 3,
      location: { lat: 6.5244, lng: 3.3792 },
    };
    this.incidents.set(incident.id, incident);

    for (let i = 1; i <= 40; i++) {
      const responder: Responder = {
        id: `R-${String(i).padStart(3, '0')}`,
        incidentId: incident.id,
        name: `Responder ${i}`,
        status: i % 7 === 0 ? 'offline' : i % 3 === 0 ? 'on_scene' : 'en_route',
        location: { lat: 6.52 + i * 1e-4, lng: 3.37 + i * 1e-4 },
      };
      this.responders.set(responder.id, responder);
      this.events.push({
        id: `E-${String(i).padStart(3, '0')}`,
        incidentId: incident.id,
        responderId: responder.id,
        type: 'location',
        at: `2026-10-21T08:0${Math.floor(i / 10)}:${String(i % 60).padStart(2, '0')}.000Z`,
        cursor: nextCursor(),
        payload: { lat: responder.location.lat, lng: responder.location.lng },
      });
    }

    this.events.push({
      id: 'E-DISPATCH-1',
      incidentId: incident.id,
      responderId: null,
      type: 'dispatch_created',
      at: '2026-10-21T08:00:00.000Z',
      cursor: nextCursor(),
      payload: { status: 'assigned' },
    });
  }

  resetQueryCount(): void {
    this.queryCount = 0;
  }

  getQueryCount(): number {
    return this.queryCount;
  }

  getIncident(id: string): Incident | null {
    this.queryCount++;
    const incident = this.incidents.get(id);
    return incident ? { ...incident } : null;
  }

  listIncidents(limit = 20, cursor?: string | null): Page<Incident> {
    this.queryCount++;
    const all = [...this.incidents.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const start = cursor ? Math.max(0, all.findIndex((incident) => incident.id === cursor) + 1) : 0;
    const items = all.slice(start, start + limit).map((incident) => ({ ...incident }));
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: items.length === limit && last ? last.id : null,
      hasNextPage: start + limit < all.length,
    };
  }

  /** One query: incident + responders (REST's hand-optimised join). */
  getIncidentBundle(id: string): { incident: Incident; responders: Responder[] } | null {
    this.queryCount += 2;
    const incident = this.incidents.get(id);
    if (!incident) return null;
    const responders = [...this.responders.values()]
      .filter((responder) => responder.incidentId === id)
      .map((responder) => ({ ...responder }));
    return { incident: { ...incident }, responders };
  }

  /** One batched query for many incidents (DataLoader source). */
  getIncidentsByIds(ids: string[]): Incident[] {
    this.queryCount++;
    return ids
      .map((id) => this.incidents.get(id))
      .filter((incident): incident is Incident => Boolean(incident))
      .map((incident) => ({ ...incident }));
  }

  /** One batched query for responders across many incidents. */
  getRespondersForIncidents(ids: string[]): Map<string, Responder[]> {
    this.queryCount++;
    const wanted = new Set(ids);
    const grouped = new Map<string, Responder[]>();
    for (const id of ids) grouped.set(id, []);
    for (const responder of this.responders.values()) {
      if (!wanted.has(responder.incidentId)) continue;
      grouped.get(responder.incidentId)?.push({ ...responder });
    }
    return grouped;
  }

  /** One batched query for events across many incidents. */
  getEventsForIncidents(ids: string[]): Map<string, DomainEvent[]> {
    this.queryCount++;
    const wanted = new Set(ids);
    const grouped = new Map<string, DomainEvent[]>();
    for (const id of ids) grouped.set(id, []);
    for (const event of this.events) {
      if (!wanted.has(event.incidentId)) continue;
      grouped.get(event.incidentId)?.push({ ...event });
    }
    return grouped;
  }

  getRespondersByIncident(incidentId: string): Responder[] {
    this.queryCount++;
    return [...this.responders.values()]
      .filter((responder) => responder.incidentId === incidentId)
      .map((responder) => ({ ...responder }));
  }

  updateResponderLocation(id: string, location: Location): Responder | null {
    this.queryCount++;
    const responder = this.responders.get(id);
    if (!responder) return null;
    responder.location = { ...location };
    return { ...responder };
  }

  getResponder(id: string): Responder | null {
    this.queryCount++;
    const responder = this.responders.get(id);
    return responder ? { ...responder } : null;
  }

  /** One batched query regardless of how many IDs the loader passes. */
  getRespondersByIds(ids: string[]): Responder[] {
    this.queryCount++;
    return ids
      .map((id) => this.responders.get(id))
      .filter((responder): responder is Responder => Boolean(responder))
      .map((responder) => ({ ...responder }));
  }

  getEventsByIncident(
    incidentId: string,
    options: { limit?: number; cursor?: string | null } = {},
  ): Page<DomainEvent> {
    this.queryCount++;
    const limit = Math.max(1, Math.min(200, options.limit ?? 20));
    const all = this.events.filter((event) => event.incidentId === incidentId);
    const start = options.cursor
      ? all.findIndex((event) => event.cursor === options.cursor) + 1
      : 0;
    const items = all.slice(Math.max(0, start), Math.max(0, start) + limit).map((event) => ({ ...event }));
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: items.length === limit && last ? last.cursor : null,
      hasNextPage: Math.max(0, start) + limit < all.length,
    };
  }

  /** One batched query for the latest event of every responder. */
  getLastEventsByResponderIds(ids: string[]): Map<string, DomainEvent | null> {
    this.queryCount++;
    const wanted = new Set(ids);
    const latest = new Map<string, DomainEvent | null>();
    for (const id of ids) latest.set(id, null);
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];
      if (!event.responderId || !wanted.has(event.responderId)) continue;
      if (latest.get(event.responderId) === null) latest.set(event.responderId, { ...event });
    }
    return latest;
  }

  /** One query: responders joined with their latest event (REST bundle). */
  getRespondersWithLastEvent(incidentId: string): ResponderWithLastEvent[] {
    this.queryCount++;
    const responders = this.getRespondersByIncidentWithoutCounting(incidentId);
    const lastEvents = this.getLastEventsWithoutCounting(responders.map((responder) => responder.id));
    return responders.map((responder) => ({
      ...responder,
      lastEvent: lastEvents.get(responder.id) ?? null,
    }));
  }

  createIncident(input: {
    id?: string;
    status?: IncidentStatus;
    priority?: Priority;
    location: Location;
  }): Incident {
    this.queryCount++;
    const id = input.id || `INC-${1_042 + this.incidents.size + 1}`;
    if (this.incidents.has(id)) {
      throw Object.assign(new Error(`incident ${id} already exists`), { code: 'conflict' });
    }
    const incident: Incident = {
      id,
      status: input.status ?? 'open',
      priority: input.priority ?? 'normal',
      createdAt: nowIso(),
      version: 1,
      location: { ...input.location },
    };
    this.incidents.set(id, incident);
    return { ...incident };
  }

  assignResponder(incidentId: string, responderId: string, expectedVersion?: number): Incident {
    this.queryCount += 2;
    const incident = this.incidents.get(incidentId);
    if (!incident) throw Object.assign(new Error('incident not found'), { code: 'not_found' });
    if (expectedVersion !== undefined && expectedVersion !== incident.version) {
      throw Object.assign(new Error('version conflict'), {
        code: 'conflict',
        serverVersion: incident.version,
        mergeProposal: { status: incident.status, priority: incident.priority },
      });
    }
    const responder = this.responders.get(responderId);
    if (!responder) throw Object.assign(new Error('responder not found'), { code: 'not_found' });
    responder.incidentId = incidentId;
    responder.status = 'assigned';
    const next: Incident = {
      ...incident,
      status: incident.status === 'open' ? 'assigned' : incident.status,
      version: incident.version + 1,
    };
    this.incidents.set(incidentId, next);
    return { ...next };
  }

  acknowledge(incidentId: string, expectedVersion?: number): Incident {
    this.queryCount++;
    const incident = this.incidents.get(incidentId);
    if (!incident) throw Object.assign(new Error('incident not found'), { code: 'not_found' });
    if (expectedVersion !== undefined && expectedVersion !== incident.version) {
      throw Object.assign(new Error('version conflict'), {
        code: 'conflict',
        serverVersion: incident.version,
        mergeProposal: { status: incident.status, priority: incident.priority },
      });
    }
    const next: Incident = {
      ...incident,
      status: 'acknowledged',
      version: incident.version + 1,
    };
    this.incidents.set(incidentId, next);
    return { ...next };
  }

  syncFlush(input: {
    incidentId: string;
    baseVersion: number;
    patch: Record<string, unknown>;
  }): SyncFlushResult {
    this.queryCount++;
    const incident = this.incidents.get(input.incidentId);
    if (!incident) {
      return {
        __typename: 'ValidationError',
        error: 'validation_failed',
        issues: [{ path: 'incidentId', message: 'incident not found' }],
      };
    }

    const issues: ValidationIssue[] = [];
    if (!Number.isInteger(input.baseVersion) || input.baseVersion < 1) {
      issues.push({ path: 'baseVersion', message: 'must be a positive integer' });
    }
    const allowed = new Set(['status', 'priority']);
    for (const key of Object.keys(input.patch || {})) {
      if (!allowed.has(key)) issues.push({ path: `patch.${key}`, message: 'unsupported field' });
    }
    if (input.patch?.status && !['open', 'assigned', 'acknowledged', 'resolved'].includes(String(input.patch.status))) {
      issues.push({ path: 'patch.status', message: 'invalid status' });
    }
    if (input.patch?.priority && !['low', 'normal', 'high', 'critical'].includes(String(input.patch.priority))) {
      issues.push({ path: 'patch.priority', message: 'invalid priority' });
    }
    if (issues.length > 0) {
      return { __typename: 'ValidationError', error: 'validation_failed', issues };
    }

    if (input.baseVersion !== incident.version) {
      return {
        __typename: 'SyncConflict',
        conflict: true,
        serverVersion: incident.version,
        mergeProposal: { status: incident.status, priority: incident.priority },
      };
    }

    const next: Incident = {
      ...incident,
      status: (input.patch?.status as IncidentStatus) || incident.status,
      priority: (input.patch?.priority as Priority) || incident.priority,
      version: incident.version + 1,
    };
    this.incidents.set(incident.id, next);
    return { __typename: 'SyncSuccess', ok: true, serverVersion: next.version, incident: { ...next } };
  }

  private getRespondersByIncidentWithoutCounting(incidentId: string): Responder[] {
    return [...this.responders.values()]
      .filter((responder) => responder.incidentId === incidentId)
      .map((responder) => ({ ...responder }));
  }

  private getLastEventsWithoutCounting(ids: string[]): Map<string, DomainEvent | null> {
    const wanted = new Set(ids);
    const latest = new Map<string, DomainEvent | null>();
    for (const id of ids) latest.set(id, null);
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];
      if (!event.responderId || !wanted.has(event.responderId)) continue;
      if (latest.get(event.responderId) === null) latest.set(event.responderId, { ...event });
    }
    return latest;
  }
}

let sharedStore: DomainStore | null = null;

export function getDomainStore(): DomainStore {
  if (!sharedStore) sharedStore = new DomainStore();
  return sharedStore;
}

export function resetDomainStore(): void {
  sharedStore?.seed();
  sharedStore?.resetQueryCount();
}

export default DomainStore;
