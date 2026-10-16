import type { Approval, Dungeon, GameEvent, Npc, Quest, SessionIndexEntry } from './types.js';

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
  | { type: 'approval_resolved'; id: string }
  | { type: 'preflight'; preflight: Preflight };

// 水晶球：session 列表與冒險日誌（HTTP 回應）
export type SessionListItem = SessionIndexEntry & { live: boolean };

export type TranscriptBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; summary: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; isError: boolean; output: string };

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  blocks: TranscriptBlock[];
}
