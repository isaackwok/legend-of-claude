export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ClassId = 'warrior' | 'scholar' | 'scout' | 'freeman';
export type BuiltinRole = 'clerk';               // 本里程碑只有公會櫃檯
export interface Npc {
  id: string; name: string; classId: ClassId; builtin?: BuiltinRole;
  persona: string; model: string; effort: Effort;
  equipment: { connectorPrefixes: string[]; readOnly: boolean };
  skills: string[]; homeDungeonId?: string;
  busyQuestId?: string; cautious?: boolean;     // cautious = 謹慎模式（退到 acceptEdits）
}
export interface Dungeon { id: string; name: string; path: string; githubRepo?: string /* owner/name */; defaultBranch?: string }
export type QuestStatus = 'open' | 'adventuring' | 'review' | 'done' | 'abandoned';
export type QuestSource = { kind: 'local' } | { kind: 'jira'; key: string; url: string };
export interface Quest {
  id: string; title: string; body: string; stars: 1|2|3|4|5;
  status: QuestStatus; source: QuestSource;
  npcId?: string; dungeonId?: string; branch?: string; worktreePath?: string; baseBranch?: string;
  sessionId?: string; scroll?: string; rejections: number;
  settlement?: SettlementRecord; createdAt: number; updatedAt: number;
}
export type QuestAction = 'start' | 'finish' | 'interrupt' | 'reject' | 'accept' | 'abandon';
export interface Approval { id: string; npcId: string; questId?: string; sessionId: string; toolName: string; summary: string; reason?: string; createdAt: number }
export type GameEventKind = 'text' | 'tool_start' | 'tool_end' | 'compact' | 'subagent_start' | 'subagent_end' | 'background_start' | 'background_end' | 'result' | 'error';
export interface GameEvent { id: string; sessionId: string; npcId: string; questId?: string; at: number; kind: GameEventKind; label: string; detail?: string; toolUseId?: string; parentToolUseId?: string | null }
export interface SettlementChoices { pushAndPr: boolean; jiraTransitionId?: string; jiraComment?: string; linkPr: boolean; openTicket: boolean }
export interface SettlementRecord { choices: SettlementChoices; prUrl?: string; results: { action: string; ok: boolean; message: string }[]; at: number }
export interface SessionIndexEntry { id: string /* sessionId */; npcId: string; questId?: string; title: string; cwd: string; updatedAt: number }
export interface Settings { id: 'settings'; scanRoot: string /* 初值 ~/dev */; lastSettlement?: SettlementChoices; connectors?: { name: string; prefix: string; status: string }[] }
