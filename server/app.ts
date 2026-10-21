import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { installDomainRoutes } from './routes/index.ts';
import { installTelemetryRoutes } from './telemetryBootstrap.js';
import type { DomainStore } from './lib/domainStore.ts';

export interface AppOptions {
  store?: DomainStore;
  telemetry?: boolean;
  graphqlPath?: string;
}

/**
 * Compose the HTTP application.
 *
 * Middleware hardening (CSP/CORS/rate limits/HTTP2 push) is installed by
 * server/hardening.ts; this factory owns only route composition so contract
 * tests can run without the ZK prover or a live collector.
 */
export function createApp(options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  if (options.telemetry !== false) installTelemetryRoutes(app);
  installDomainRoutes(app, { store: options.store, graphqlPath: options.graphqlPath });

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const typed = error as { status?: number; type?: string; message?: string };
    const status = typed.status ?? (typed.type === 'entity.parse.failed' ? 400 : 500);
    res.status(status).json({
      error: status === 400 ? 'bad_request' : 'internal_error',
      message: status === 400 ? 'invalid JSON body' : 'unexpected server error',
    });
  });

  return app;
}

export default createApp;
