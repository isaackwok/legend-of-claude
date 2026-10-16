import type { Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { ApprovalBroker } from './agent/approvals.js';
import { realQueryFn } from './agent/queryFn.js';
import { ChatService } from './chats/service.js';
import { ClerkService } from './clerk/clerk.js';
import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { clientDirWarning } from './http/static.js';
import { ensureSeedNpcs } from './npcs/seeds.js';
import { runPreflight, sdkEnv } from './preflight.js';
import { PreflightState } from './preflightState.js';
import { QuestService } from './quests/service.js';
import { buildSnapshot } from './snapshot.js';
import { FileSessionStore } from './store/fileSessionStore.js';
import { repos as makeRepos } from './store/jsonRepo.js';
import { WsHub } from './ws/hub.js';

const config = loadConfig();
// `npm start` sets LOC_SERVE_CLIENT=1: serve the built client from this port instead of relying on the Vite dev server.
const serveClient = process.env['LOC_SERVE_CLIENT'] === '1';
const clientDir = serveClient ? fileURLToPath(new URL('../../client/dist', import.meta.url)) : undefined;
const publicPort = serveClient ? config.port : config.clientPort;
const missingClient = clientDir ? clientDirWarning(clientDir) : undefined;
if (missingClient) console.warn(`[前端] ${missingClient}`);
const repos = makeRepos(config.dataDir);
await ensureSeedNpcs(repos);

// Placeholder until the startup check finishes; the finished result is broadcast to connected clients.
const preflightState = new PreflightState({ ignoredEnvVars: sdkEnv().ignored, loggedIn: true, warnings: [] }, (msg) => hub.broadcast(msg));
const getPreflight = () => preflightState.get();
const broker = new ApprovalBroker();
const getSnapshot = () => buildSnapshot(repos, preflightState.get(), broker.list());

const hub = new WsHub(getSnapshot);
broker.onChange((msg) => hub.broadcast(msg));

const sessionStore = new FileSessionStore(join(config.dataDir, 'sessions'));
// The clerk is created below; launches only call this after startup has finished.
const quests = new QuestService({
  repos,
  hub,
  broker,
  queryFn: realQueryFn,
  dataDir: config.dataDir,
  sessionStore,
  ensureInventory: () => clerk.ensureInventory(),
});
// Nothing is running yet: quests left adventuring by the last run go back to open before serving.
await quests.recoverInterrupted();

const clerk = new ClerkService({ repos, hub, broker, queryFn: realQueryFn, dataDir: config.dataDir, sessionStore, quests });
const chats = new ChatService({ repos, hub, broker, queryFn: realQueryFn, dataDir: config.dataDir, sessionStore });

const app = createApp({ config, repos, hub, getSnapshot, getPreflight, quests, broker, clerk, chats, sessionStore, clientDir });

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, () => {
  console.log(`克勞德傳說已啟動：http://127.0.0.1:${publicPort}/?token=${config.token}`);
}) as Server;
hub.attach(server, config);

void runPreflight(realQueryFn, { dataDir: config.dataDir }).then((result) => {
  preflightState.set(result);
  for (const w of result.warnings) console.warn(`[啟動檢查] ${w}`);
  // 倉庫盤點 once logged in, so NPC connector equipment is enforced (without an inventory nothing is denied).
  if (result.loggedIn) {
    clerk.refreshInventory().then(
      (connectors) => console.log(`[倉庫盤點] 找到 ${connectors.length} 個 connector`),
      (err: unknown) => console.warn(`[倉庫盤點] 失敗：${err instanceof Error ? err.message : String(err)}`),
    );
  }
});
