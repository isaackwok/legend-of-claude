import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repos as makeRepos, type Repos } from './jsonRepo.js';
import { getSettings, updateSettings } from './settings.js';

let dir: string;
let repos: Repos;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'loc-settings-'));
  repos = makeRepos(dir);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('settings', () => {
  it('creates and stores the default record lazily', async () => {
    const s = await getSettings(repos);
    expect(s).toEqual({ id: 'settings', scanRoot: join(homedir(), 'dev') });
    expect(await repos.settings.get('settings')).toEqual(s);
  });

  it('returns the stored record when present', async () => {
    await repos.settings.put({ id: 'settings', scanRoot: '/somewhere' });
    expect((await getSettings(repos)).scanRoot).toBe('/somewhere');
  });

  it('updateSettings merges a patch and persists it', async () => {
    const next = await updateSettings(repos, { scanRoot: '/else' });
    expect(next).toEqual({ id: 'settings', scanRoot: '/else' });
    expect(await getSettings(repos)).toEqual(next);
  });
});
