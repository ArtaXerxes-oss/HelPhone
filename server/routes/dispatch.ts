/**
 * REST dispatch surface — canonical write/read path.
 *
 * Shapes are aligned with server/graphql/schema.graphql:
 *   { incident: { id, status, priority, version, location, responders, events } }
 *
 * Validation failures are 422 + issues[]; optimistic-concurrency failures are
 * 409 + serverVersion + mergeProposal, the same payload the GraphQL
 * SyncConflict union carries.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDomainStore, type DomainStore } from '../lib/domainStore.ts';
import { getSqlCache, invalidateIncident } from '../lib/sqlCache.ts';

const prioritySchema = z.enum(['low', 'normal', 'high', 'critical']);
const statusSchema = z.enum(['open', 'assigned', 'acknowledged', 'resolved']);
const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const createIncidentSchema = z.object({
  id: z.string().min(3).max(64).optional(),
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  location: locationSchema,
});

const assignSchema = z.object({
  responderId: z.string().min(1),
  expectedVersion: z.number().int().positive().optional(),
});

const ackSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
});

function issuesOf(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || 'body',
    message: issue.message,
  }));
}

function validationResponse(res: Response, issues: Array<{ path: string; message: string }>) {
  return res.status(422).json({ error: 'validation_failed', issues });
}

function conflictResponse(res: Response, serverVersion: number, mergeProposal: Record<string, unknown>) {
  return res.status(409).json({ conflict: true, serverVersion, mergeProposal });
}

export function createDispatchRouter(options: { store?: DomainStore } = {}): Router {
  const store = options.store ?? getDomainStore();
  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const page = store.listIncidents(limit, cursor);
    res.set('Cache-Control', 'no-store').json({
      incidents: page.items,
      nextCursor: page.nextCursor,
      hasNextPage: page.hasNextPage,
    });
  });

  router.get('/:id', async (req: Request, res: Response) => {
    const id = req.params.id;
    const bypass = req.query.nocache === '1' || req.query.nocache === 'true';
    const bundle = await getSqlCache().withCache(
      'rest',
      `dispatch:${id}`,
      () => {
        const incident = store.getIncident(id);
        if (!incident) return null;
        // One joined query for responders + latest event (the store's
        // getRespondersWithLastEvent performs the join internally).
        const responders = store.getRespondersWithLastEvent(id);
        return { incident: { ...incident, responders }, responders };
      },
      { bypass, ttlMs: 2_000 },
    );

    if (!bundle) {
      res.status(404).json({ error: 'not_found', message: `incident ${id} not found` });
      return;
    }
    res.set('Cache-Control', 'no-store').json({ incident: bundle.incident });
  });

  router.post('/', (req: Request, res: Response) => {
    const parsed = createIncidentSchema.safeParse(req.body);
    if (!parsed.success) {
      validationResponse(res, issuesOf(parsed.error));
      return;
    }
    try {
      const incident = store.createIncident(parsed.data);
      invalidateIncident(incident.id);
      res.status(201).json({ incident });
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      if (typed.code === 'conflict') {
        conflictResponse(res, 0, { reason: typed.message });
        return;
      }
      res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/:id/assign', (req: Request, res: Response) => {
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) {
      validationResponse(res, issuesOf(parsed.error));
      return;
    }
    try {
      const incident = store.assignResponder(req.params.id, parsed.data.responderId, parsed.data.expectedVersion);
      invalidateIncident(req.params.id);
      res.json({ incident });
    } catch (error) {
      const typed = error as {
        code?: string;
        message?: string;
        serverVersion?: number;
        mergeProposal?: Record<string, unknown>;
      };
      if (typed.code === 'conflict') {
        conflictResponse(res, typed.serverVersion ?? 0, typed.mergeProposal ?? {});
        return;
      }
      if (typed.code === 'not_found') {
        res.status(404).json({ error: 'not_found', message: typed.message });
        return;
      }
      res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/:id/ack', (req: Request, res: Response) => {
    const parsed = ackSchema.safeParse(req.body);
    if (!parsed.success) {
      validationResponse(res, issuesOf(parsed.error));
      return;
    }
    try {
      const incident = store.acknowledge(req.params.id, parsed.data.expectedVersion);
      invalidateIncident(req.params.id);
      res.json({ incident });
    } catch (error) {
      const typed = error as {
        code?: string;
        message?: string;
        serverVersion?: number;
        mergeProposal?: Record<string, unknown>;
      };
      if (typed.code === 'conflict') {
        conflictResponse(res, typed.serverVersion ?? 0, typed.mergeProposal ?? {});
        return;
      }
      if (typed.code === 'not_found') {
        res.status(404).json({ error: 'not_found', message: typed.message });
        return;
      }
      res.status(500).json({ error: 'internal_error' });
    }
  });

  return router;
}

export default createDispatchRouter;
