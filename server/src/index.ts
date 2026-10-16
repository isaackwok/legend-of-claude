import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import type { Preflight } from '@loc/shared';
import { realQueryFn } from './agent/queryFn.js';
import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { runPreflight, sdkEnv } from './preflight.js';
import { buildSnapshot } from './snapshot.js';
import { repos as makeRepos } from './store/jsonRepo.js';
import { WsHub } from './ws/hub.js';

const config = loadConfig();
const repos = makeRepos(config.dataDir);

// Placeholder until the startup check finishes.
let preflight: Preflight = { ignoredEnvVars: sdkEnv().ignored, loggedIn: true, warnings: [] };
const getPreflight = () => preflight;
const getSnapshot = () => buildSnapshot(repos, preflight);

const app = createApp({ config, repos, getSnapshot, getPreflight });
const hub = new WsHub(getSnapshot);

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, () => {
  console.log(`克勞德傳說已啟動：http://127.0.0.1:${config.clientPort}/?token=${config.token}`);
}) as Server;
hub.attach(server, config);

void runPreflight(realQueryFn, { dataDir: config.dataDir }).then((result) => {
  preflight = result;
  for (const w of result.warnings) console.warn(`[啟動檢查] ${w}`);
});
