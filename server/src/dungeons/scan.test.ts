import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dungeon, ServerMessage } from '@loc/shared';
import { fakeQuery } from '../../test/fakeQuery.js';
import { ApprovalBroker } from '../agent/approvals.js';
import { ChatService } from '../chats/service.js';
import { ClerkService } from '../clerk/clerk.js';
import { loadConfig, type Config } from '../config.js';
import { createApp } from '../http/app.js';
import { QuestService } from '../quests/service.js';
import { buildSnapshot } from '../snapshot.js';
import { FileSessionStore } from '../store/fileSessionStore.js';
import { repos as makeRepos, type Repos } from '../store/jsonRepo.js';
import { inspectRepo, parseGithubRemote, scanForRepos } from './scan.js';

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run('git', args, { cwd });

async function initRepo(path: string, remote?: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, 'init', '-q', '-b', 'main');
  if (remote) await git(path, 'remote', 'add', 'origin', remote);
}

let tmp: string; // realpath'd (macOS /var -> /private/var)
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'loc-dungeon-')));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

describe('parseGithubRemote', () => {
  it('parses ssh, https and https-without-.git forms', () => {
    expect(parseGithubRemote('git@github.com:o/r.git')).toBe('o/r');
    expect(parseGithubRemote('https://github.com/o/r.git')).toBe('o/r');
    expect(parseGithubRemote('https://github.com/o/r')).toBe('o/r');
    expect(parseGithubRemote('ssh://git@github.com/o/r.git')).toBe('o/r');
  });
  it('returns undefined for non-GitHub or malformed urls', () => {
    expect(parseGithubRemote('git@gitlab.com:o/r.git')).toBeUndefined();
    expect(parseGithubRemote('https://github.com/o')).toBeUndefined();
    expect(parseGithubRemote('https://evil.com/github.com/o/r')).toBeUndefined();
    expect(parseGithubRemote('')).toBeUndefined();
  });
});

describe('inspectRepo', () => {
  it('reads the origin remote and branch of a repo with no commits', async () => {
    await initRepo(join(tmp, 'a'), 'git@github.com:acme/widgets.git');
    expect(await inspectRepo(join(tmp, 'a'))).toEqual({ githubRepo: 'acme/widgets', defaultBranch: 'main' });
  });
  it('has no githubRepo without a remote', async () => {
    await initRepo(join(tmp, 'a'));
    expect(await inspectRepo(join(tmp, 'a'))).toEqual({ defaultBranch: 'main' });
  });
});

describe('scanForRepos', () => {
  it('finds git projects, skips non-git folders, and does not descend into repos', async () => {
    await initRepo(join(tmp, 'one'), 'https://github.com/acme/one.git');
    await initRepo(join(tmp, 'group', 'two'));
    await initRepo(join(tmp, 'one', 'nested'));
    await mkdir(join(tmp, 'plain', 'x'), { recursive: true });
    const found = await scanForRepos(tmp);
    expect(found.map((f) => f.name).sort()).toEqual(['one', 'two']);
    expect(found.find((f) => f.name === 'one')).toEqual({ name: 'one', path: join(tmp, 'one'), githubRepo: 'acme/one' });
    expect(found.find((f) => f.name === 'two')?.githubRepo).toBeUndefined();
  });

  it('respects maxDepth, skips node_modules and dot-directories, ignores symlinks', async () => {
    await initRepo(join(tmp, 'a', 'b', 'deep'));
    await initRepo(join(tmp, 'node_modules', 'pkg'));
    await initRepo(join(tmp, '.hidden', 'repo'));
    await initRepo(join(tmp, 'real'));
    await mkdir(join(tmp, 'links'));
    await symlink(join(tmp, 'real'), join(tmp, 'links', 'alias'));
    expect((await scanForRepos(tmp)).map((f) => f.name)).toEqual(['real']);
    expect((await scanForRepos(tmp, 3)).map((f) => f.name).sort()).toEqual(['deep', 'real']);
  });

  it('returns [] for a missing root', async () => {
    expect(await scanForRepos(join(tmp, 'nope'))).toEqual([]);
  });
});

describe('/api/dungeons', () => {
  let dir: string;
  let config: Config;
  let repos: Repos;
  let broadcasts: ServerMessage[];
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    dir = join(tmp, 'data');
    config = loadConfig({ LOC_DATA_DIR: dir });
    repos = makeRepos(dir);
    broadcasts = [];
    const preflight = { ignoredEnvVars: [], loggedIn: true, warnings: [] };
    const hub = { broadcast: (m: ServerMessage) => void broadcasts.push(m) };
    const broker = new ApprovalBroker();
    const sessionStore = new FileSessionStore(join(dir, 'sessions'));
    const quests = new QuestService({ repos, hub, broker, queryFn: fakeQuery([]).fn, dataDir: dir, sessionStore });
    const clerk = new ClerkService({ repos, hub, broker, queryFn: fakeQuery([]).fn, dataDir: dir, sessionStore, quests });
    const chats = new ChatService({ repos, hub, broker, queryFn: fakeQuery([]).fn, dataDir: dir, sessionStore });
    app = createApp({
      config,
      repos,
      hub,
      getSnapshot: () => buildSnapshot(repos, preflight),
      getPreflight: () => preflight,
      quests,
      broker,
      clerk,
      chats,
      sessionStore,
    });
  });

  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        Host: '127.0.0.1:4517',
        Authorization: `Bearer ${config.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  const post = (body: unknown) => req('/api/dungeons', { method: 'POST', body: JSON.stringify(body) });

  it('requires auth', async () => {
    const res = await app.request('/api/dungeons', { headers: { Host: '127.0.0.1:4517' } });
    expect(res.status).toBe(401);
  });

  it('POST rejects non-git and non-existent paths with 400', async () => {
    await mkdir(join(tmp, 'plain'));
    for (const path of [join(tmp, 'plain'), join(tmp, 'missing')]) {
      const res = await post({ path });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: '這不是 git 專案' });
    }
    expect((await post({})).status).toBe(400);
    expect(await repos.dungeons.list()).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it('POST registers a repo, broadcasts it, and is idempotent per path', async () => {
    const repo = join(tmp, 'proj');
    await initRepo(repo, 'git@github.com:acme/proj.git');
    const res = await post({ path: repo });
    expect(res.status).toBe(201);
    const dungeon = (await res.json()) as Dungeon;
    expect(dungeon).toMatchObject({ name: 'proj', path: repo, githubRepo: 'acme/proj', defaultBranch: 'main' });
    expect(dungeon.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(broadcasts).toEqual([{ type: 'dungeon', dungeon }]);

    await symlink(repo, join(tmp, 'proj-link'));
    const again = await post({ path: join(tmp, 'proj-link') });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(dungeon);
    expect(await repos.dungeons.list()).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
  });

  it('GET lists registered dungeons; DELETE removes one (204) and 404s on unknown', async () => {
    const repo = join(tmp, 'proj');
    await initRepo(repo);
    const dungeon = (await (await post({ path: repo })).json()) as Dungeon;
    expect(await (await req('/api/dungeons')).json()).toEqual([dungeon]);
    expect((await req(`/api/dungeons/${dungeon.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await (await req('/api/dungeons')).json()).toEqual([]);
    expect((await req(`/api/dungeons/${dungeon.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('GET /scan uses ?root= or falls back to settings.scanRoot', async () => {
    const root = join(tmp, 'scanme');
    await initRepo(join(root, 'p1'));
    const explicit = await (await req(`/api/dungeons/scan?root=${encodeURIComponent(root)}`)).json();
    expect(explicit).toEqual([{ name: 'p1', path: join(root, 'p1') }]);

    await repos.settings.put({ id: 'settings', scanRoot: root });
    const fallback = await (await req('/api/dungeons/scan')).json();
    expect(fallback).toEqual(explicit);
  });
});
