import type { Preflight, Snapshot } from '@loc/shared';
import type { Repos } from './store/jsonRepo.js';

export function buildSnapshot(repos: Repos, preflight: Preflight): Promise<Snapshot> {
  return Promise.all([repos.quests.list(), repos.npcs.list(), repos.dungeons.list()]).then(
    ([quests, npcs, dungeons]) => ({ quests, npcs, dungeons, approvals: [], preflight }),
  );
}
