import type { Server } from 'node:http';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { Preflight } from '@loc/shared';
import { ApprovalBroker } from './agent/approvals.js';
import { realQueryFn } from './agent/queryFn.js';
import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { ensureSeedNpcs } from './npcs/seeds.js';
import { runPreflight, sdkEnv } from './preflight.js';
import { QuestService } from './quests/service.js';
import { buildSnapshot } from './snapshot.js';
import { FileSessionStore } from './store/fileSessionStore.js';
import { repos as makeRepos } from './store/jsonRepo.js';
import { WsHub } from './ws/hub.js';

const config = loadConfig();
const repos = makeRepos(config.dataDir);
await ensureSeedNpcs(repos);

// Placeholder until the startup check finishes.
let preflight: Preflight = { ignoredEnvVars: sdkEnv().ignored, loggedIn: true, warnings: [] };
const getPreflight = () => preflight;
const broker = new ApprovalBroker();
const getSnapshot = () => buildSnapshot(repos, preflight, broker.list());

const hub = new WsHub(getSnapshot);
broker.onChange((msg) => hub.broadcast(msg));

const sessionStore = new FileSessionStore(join(config.dataDir, 'sessions'));
const quests = new QuestService({ repos, hub, broker, queryFn: realQueryFn, dataDir: config.dataDir, sessionStore });
// Nothing is running yet: quests left adventuring by the last run go back to open before serving.
await quests.recoverInterrupted();

const app = createApp({ config, repos, hub, getSnapshot, getPreflight, quests, broker });

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, () => {
  console.log(`克勞德傳說已啟動：http://127.0.0.1:${config.clientPort}/?token=${config.token}`);
}) as Server;
hub.attach(server, config);

void runPreflight(realQueryFn, { dataDir: config.dataDir }).then((result) => {
  preflight = result;
  for (const w of result.warnings) console.warn(`[啟動檢查] ${w}`);
});
