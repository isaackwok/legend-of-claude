import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Hono } from 'hono';
import type { Dungeon, ServerMessage } from '@loc/shared';
import { inspectRepo, isGitProject, scanForRepos } from '../../dungeons/scan.js';
import type { Repos } from '../../store/jsonRepo.js';
import { getSettings } from '../../store/settings.js';

export interface DungeonRouteDeps {
  repos: Repos;
  hub: { broadcast(msg: ServerMessage): void };
}

const NOT_GIT = '這不是 git 專案';

/** Resolve to an absolute real path, or undefined when it isn't an existing directory. */
async function resolveDir(input: string): Promise<string | undefined> {
  try {
    const real = await realpath(resolve(input));
    return (await stat(real)).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

export function dungeonRoutes({ repos, hub }: DungeonRouteDeps): Hono {
  const app = new Hono();

  app.get('/', async (c) => c.json(await repos.dungeons.list()));

  app.get('/scan', async (c) => {
    const root = c.req.query('root') || (await getSettings(repos)).scanRoot;
    return c.json(await scanForRepos(resolve(root)));
  });

  app.post('/', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const input = (body as { path?: unknown } | undefined)?.path;
    if (typeof input !== 'string' || input.trim() === '') return c.json({ error: NOT_GIT }, 400);
    const path = await resolveDir(input);
    if (!path || !(await isGitProject(path))) return c.json({ error: NOT_GIT }, 400);

    const existing = (await repos.dungeons.list()).find((d) => d.path === path);
    if (existing) return c.json(existing, 200);

    const { githubRepo, defaultBranch } = await inspectRepo(path);
    const dungeon: Dungeon = {
      id: randomUUID(),
      name: basename(path),
      path,
      ...(githubRepo ? { githubRepo } : {}),
      defaultBranch,
    };
    await repos.dungeons.put(dungeon);
    hub.broadcast({ type: 'dungeon', dungeon });
    return c.json(dungeon, 201);
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (!(await repos.dungeons.get(id))) return c.json({ error: '找不到這座地下城' }, 404);
    await repos.dungeons.remove(id);
    // ServerMessage has no removal variant (protocol is out of scope here), so nothing is broadcast.
    return c.body(null, 204);
  });

  return app;
}
