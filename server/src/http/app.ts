import { Hono } from 'hono';
import type { Preflight, ServerMessage, Snapshot } from '@loc/shared';
import type { ApprovalBroker } from '../agent/approvals.js';
import type { Config } from '../config.js';
import type { QuestService } from '../quests/service.js';
import type { Repos } from '../store/jsonRepo.js';
import { approvalRoutes } from './routes/approvals.js';
import { dungeonRoutes } from './routes/dungeons.js';
import { preflightRoutes } from './routes/preflight.js';
import { questRoutes } from './routes/quests.js';
import { requireAuth, requireHost } from './security.js';

/** Services the HTTP layer needs; later tasks add to this. */
export interface AppDeps {
  config: Config;
  repos: Repos;
  hub: { broadcast(msg: ServerMessage): void };
  getSnapshot: () => Promise<Snapshot>;
  getPreflight: () => Preflight;
  quests: QuestService;
  broker: ApprovalBroker;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const api = new Hono();
  api.use('*', requireHost(deps.config));
  api.use('*', requireAuth(deps.config));
  api.route('/preflight', preflightRoutes(deps.getPreflight));
  api.route('/dungeons', dungeonRoutes({ repos: deps.repos, hub: deps.hub }));
  api.route('/quests', questRoutes(deps.quests));
  api.route('/approvals', approvalRoutes(deps.broker));
  app.route('/api', api);
  return app;
}
