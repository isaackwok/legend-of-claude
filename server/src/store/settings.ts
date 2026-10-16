import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Settings } from '@loc/shared';
import type { Repos } from './jsonRepo.js';

export const SETTINGS_ID = 'settings' as const;

/** The stored settings record, created with defaults on first use. */
export async function getSettings(repos: Repos): Promise<Settings> {
  const existing = await repos.settings.get(SETTINGS_ID);
  if (existing) return existing;
  return repos.settings.put({ id: SETTINGS_ID, scanRoot: join(homedir(), 'dev') });
}

export async function updateSettings(repos: Repos, patch: Partial<Omit<Settings, 'id'>>): Promise<Settings> {
  const current = await getSettings(repos);
  return repos.settings.put({ ...current, ...patch, id: SETTINGS_ID });
}
