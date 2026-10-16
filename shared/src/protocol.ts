import type { Approval, Dungeon, GameEvent, Npc, Quest } from './types.js';

export interface Preflight {
  ignoredEnvVars: string[];
  apiKeySource?: string;
  loggedIn: boolean;
  warnings: string[];
}

export interface Snapshot {
  quests: Quest[];
  npcs: Npc[];
  dungeons: Dungeon[];
  approvals: Approval[];
  preflight: Preflight;
}

// WS 伺服器 → 客戶端訊息
export type ServerMessage =
  | { type: 'snapshot'; quests: Quest[]; npcs: Npc[]; dungeons: Dungeon[]; approvals: Approval[]; preflight: Preflight }
  | { type: 'quest'; quest: Quest }
  | { type: 'npc'; npc: Npc }
  | { type: 'dungeon'; dungeon: Dungeon }
  | { type: 'event'; event: GameEvent }
  | { type: 'approval'; approval: Approval }
  | { type: 'approval_resolved'; id: string };
