import { Hono } from 'hono';
import type { Preflight, Snapshot } from '@loc/shared';
import type { Config } from '../config.js';
import type { Repos } from '../store/jsonRepo.js';
import { preflightRoutes } from './routes/preflight.js';
import { requireAuth } from './security.js';

/** Services the HTTP layer needs; later tasks add to this. */
export interface AppDeps {
  config: Config;
  repos: Repos;
  getSnapshot: () => Promise<Snapshot>;
  getPreflight: () => Preflight;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const api = new Hono();
  api.use('*', requireAuth(deps.config));
  api.route('/preflight', preflightRoutes(deps.getPreflight));
  app.route('/api', api);
  return app;
}
