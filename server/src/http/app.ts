import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';
import { Hono } from 'hono';
import type { Preflight, ServerMessage, Snapshot } from '@loc/shared';
import type { ApprovalBroker } from '../agent/approvals.js';
import type { ChatService } from '../chats/service.js';
import type { ClerkService } from '../clerk/clerk.js';
import type { Config } from '../config.js';
import type { QuestService } from '../quests/service.js';
import type { Repos } from '../store/jsonRepo.js';
import { approvalRoutes } from './routes/approvals.js';
import { chatRoutes } from './routes/chats.js';
import { dungeonRoutes } from './routes/dungeons.js';
import { inventoryRoutes } from './routes/inventory.js';
import { jiraRoutes } from './routes/jira.js';
import { preflightRoutes } from './routes/preflight.js';
import { questRoutes } from './routes/quests.js';
import { sessionRoutes } from './routes/sessions.js';
import { settlementRoutes } from './routes/settlement.js';
import { requireAuth, requireHost } from './security.js';
import { staticClient } from './static.js';

/** Services the HTTP layer needs; later tasks add to this. */
export interface AppDeps {
  config: Config;
  repos: Repos;
  hub: { broadcast(msg: ServerMessage): void };
  getSnapshot: () => Promise<Snapshot>;
  getPreflight: () => Preflight;
  quests: QuestService;
  broker: ApprovalBroker;
  clerk: ClerkService;
  chats: ChatService;
  sessionStore: SessionStore;
  /** Production mode: directory of the built client to serve (with SPA fallback). Omit in dev (Vite serves it). */
  clientDir?: string;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const api = new Hono();
  api.use('*', requireHost(deps.config));
  api.use('*', requireAuth(deps.config));
  api.route('/preflight', preflightRoutes(deps.getPreflight));
  api.route('/dungeons', dungeonRoutes({ repos: deps.repos, hub: deps.hub }));
  api.route('/quests', questRoutes(deps.quests));
  api.route('/quests', settlementRoutes(deps.clerk));
  api.route('/jira', jiraRoutes(deps.clerk));
  api.route('/inventory', inventoryRoutes(deps.clerk));
  api.route('/approvals', approvalRoutes(deps.broker));
  api.route('/chats', chatRoutes(deps.chats));
  api.route(
    '/sessions',
    sessionRoutes({ repos: deps.repos, sessionStore: deps.sessionStore, liveSessionIds: () => [...deps.quests.liveSessionIds(), ...deps.chats.liveSessionIds()] }),
  );
  app.route('/api', api);
  if (deps.clientDir) app.use('*', staticClient(deps.clientDir, deps.config));
  return app;
}
