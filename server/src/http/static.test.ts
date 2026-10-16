import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Preflight } from '@loc/shared';
import { fakeQuery } from '../../test/fakeQuery.js';
import { ApprovalBroker } from '../agent/approvals.js';
import { ChatService } from '../chats/service.js';
import { ClerkService } from '../clerk/clerk.js';
import { loadConfig, type Config } from '../config.js';
import { QuestService } from '../quests/service.js';
import { buildSnapshot } from '../snapshot.js';
import { FileSessionStore } from '../store/fileSessionStore.js';
import { repos as makeRepos } from '../store/jsonRepo.js';
import { createApp } from './app.js';

const preflight: Preflight = { ignoredEnvVars: [], loggedIn: true, warnings: [] };
const INDEX = '<!doctype html><title>fake client</title><div id="root"></div>';
const SECRET = 'SECRET-OUTSIDE-DIST';

let dir: string;
let distDir: string;
let config: Config;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'loc-static-'));
  distDir = join(dir, 'dist');
  await mkdir(join(distDir, 'assets'), { recursive: true });
  await writeFile(join(distDir, 'index.html'), INDEX);
  await writeFile(join(distDir, 'assets', 'app.js'), 'console.log(1)');
  await writeFile(join(dir, 'package.json'), SECRET);
  config = loadConfig({ LOC_DATA_DIR: dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeApp(clientDir: string | null = distDir) {
  const repos = makeRepos(dir);
  const getSnapshot = () => buildSnapshot(repos, preflight);
  const hub = { broadcast: () => undefined };
  const broker = new ApprovalBroker();
  const sessionStore = new FileSessionStore(join(dir, 'sessions'));
  const quests = new QuestService({ repos, hub, broker, queryFn: fakeQuery([]).fn, dataDir: dir, sessionStore });
  const clerk = new ClerkService({ repos, hub, broker, queryFn: fakeQuery([]).fn, dataDir: dir, sessionStore, quests });
  const chats = new ChatService({ repos, hub, broker, queryFn: fakeQuery([]).fn, dataDir: dir, sessionStore });
  const app = createApp({ config, repos, hub, getSnapshot, getPreflight: () => preflight, quests, broker, clerk, chats, sessionStore, clientDir: clientDir ?? undefined });
  return (path: string, headers: Record<string, string> = { Host: '127.0.0.1:4517' }, method = 'GET') => app.request(path, { method, headers });
}

describe('static client (production mode)', () => {
  it('serves index.html at / without a token', async () => {
    const res = await makeApp()('/?token=whatever');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe(INDEX);
  });

  it('serves built assets with the right type', async () => {
    const res = await makeApp()('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(await res.text()).toBe('console.log(1)');
  });

  it('falls back to index.html for unknown client routes', async () => {
    const res = await makeApp()('/guild/quests/42');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX);
  });

  it('404s a missing asset instead of returning HTML', async () => {
    expect((await makeApp()('/assets/missing.js')).status).toBe(404);
  });

  it('403s a disallowed Host for the page, assets and SPA routes (DNS rebinding)', async () => {
    const app = makeApp();
    for (const path of ['/', '/assets/app.js', '/guild/quests/42']) {
      for (const host of ['evil.example', 'evil.example:4517', '127.0.0.1:9999', '127.0.0.1']) {
        expect((await app(path, { Host: host })).status, `${host} ${path}`).toBe(403);
      }
    }
    expect((await app('/', {})).status).toBe(403);
  });

  it('allows localhost:4517 as Host', async () => {
    expect((await makeApp()('/', { Host: 'localhost:4517' })).status).toBe(200);
  });

  it('keeps /api behind the token', async () => {
    const app = makeApp();
    expect((await app('/api/preflight')).status).toBe(401);
    expect((await app('/api/nope')).status).toBe(401);
    expect((await app('/api/preflight', { Host: '127.0.0.1:4517', Authorization: `Bearer ${config.token}` })).status).toBe(200);
  });

  it('does not serve the SPA for /ws over HTTP', async () => {
    expect((await makeApp()('/ws')).status).toBe(404);
  });

  it('does not escape the dist folder via path traversal', async () => {
    const app = makeApp();
    for (const path of ['/..%2f..%2fpackage.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/assets/..%2f..%2fpackage.json', '/..%5cpackage.json', '/%00']) {
      const res = await app(path);
      const text = await res.text();
      expect(text, path).not.toContain(SECRET);
    }
    expect((await app('/..%2f..%2fpackage.json')).status).toBe(404);
  });

  it('serves nothing when no clientDir is configured (dev mode)', async () => {
    expect((await makeApp(null)('/')).status).toBe(404);
  });
});
