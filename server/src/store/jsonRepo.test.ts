import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonRepo, repos } from './jsonRepo.js';

interface Item { id: string; n: number }

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'loc-jsonrepo-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('JsonRepo', () => {
  it('returns [] when the file does not exist', async () => {
    expect(await new JsonRepo<Item>(join(dir, 'none.json')).list()).toEqual([]);
  });

  it('put then get returns the same object; put with same id replaces', async () => {
    const repo = new JsonRepo<Item>(join(dir, 'a.json'));
    await repo.put({ id: 'x', n: 1 });
    expect(await repo.get('x')).toEqual({ id: 'x', n: 1 });
    await repo.put({ id: 'x', n: 2 });
    expect(await repo.list()).toEqual([{ id: 'x', n: 2 }]);
  });

  it('remove makes get return undefined', async () => {
    const repo = new JsonRepo<Item>(join(dir, 'a.json'));
    await repo.put({ id: 'x', n: 1 });
    await repo.remove('x');
    expect(await repo.get('x')).toBeUndefined();
    await repo.remove('never'); // no-op
  });

  it('20 concurrent puts of different ids all survive', async () => {
    const repo = new JsonRepo<Item>(join(dir, 'a.json'));
    await Promise.all(Array.from({ length: 20 }, (_, i) => repo.put({ id: `i${i}`, n: i })));
    expect(await repo.list()).toHaveLength(20);
  });

  it('leaves no temp files behind and persists across instances', async () => {
    const file = join(dir, 'a.json');
    await new JsonRepo<Item>(file).put({ id: 'x', n: 1 });
    expect(await readdir(dir)).toEqual(['a.json']);
    expect(await new JsonRepo<Item>(file).get('x')).toEqual({ id: 'x', n: 1 });
  });

  it('a failed write does not poison the queue', async () => {
    const repo = new JsonRepo<Item>(join(dir, 'a.json'));
    const circular: Item & { self?: unknown } = { id: 'bad', n: 0 };
    circular.self = circular;
    await expect(repo.put(circular)).rejects.toThrow();
    await repo.put({ id: 'ok', n: 1 });
    expect(await repo.list()).toEqual([{ id: 'ok', n: 1 }]);
  });
});

describe('JsonRepo permissions', () => {
  it.skipIf(process.platform === 'win32')('creates the directory 0700 and the file 0600', async () => {
    const sub = join(dir, 'data', 'nested');
    await new JsonRepo<Item>(join(sub, 'a.json')).put({ id: 'x', n: 1 });
    expect((await stat(sub)).mode & 0o777).toBe(0o700);
    expect((await stat(join(sub, 'a.json'))).mode & 0o777).toBe(0o600);
  });
});

describe('repos', () => {
  it('creates independent repos under dataDir', async () => {
    const r = repos(dir);
    await r.settings.put({ id: 'settings', scanRoot: '~/dev' });
    await r.sessions.put({ id: 's1', npcId: 'n', title: 't', cwd: '/x', updatedAt: 1 });
    expect(await r.settings.get('settings')).toEqual({ id: 'settings', scanRoot: '~/dev' });
    expect(await r.quests.list()).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual(['sessions.json', 'settings.json']);
  });
});
