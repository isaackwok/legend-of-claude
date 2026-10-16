import { randomUUID } from 'node:crypto';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { GameEvent, GameEventKind } from '@loc/shared';

const DETAIL_MAX = 2000;
const LABEL_MAX = 120;
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const FILE_TOOLS = new Set(['Edit', 'Write', 'Read']);

type StartKind = Extract<GameEventKind, 'tool_start' | 'subagent_start' | 'background_start'>;
const END_KIND: Record<StartKind, GameEventKind> = { tool_start: 'tool_end', subagent_start: 'subagent_end', background_start: 'background_end' };

/** Per-run memory of started tools so a later `tool_result` maps to the right end kind and label. */
export type ToolTracker = Map<string, { kind: StartKind; label: string }>;

export interface TranslateContext {
  npcId: string;
  questId?: string;
  tracker?: ToolTracker;
}

/** Short UI label for a tool call: Bash → command, Edit/Write/Read → path, `mcp__x__y` → `x / y`. */
export function summarizeTool(toolName: string, input: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
  if (toolName === 'Bash') return str(input['command']) ?? toolName;
  if (FILE_TOOLS.has(toolName)) return str(input['file_path']) ?? toolName;
  if (toolName.startsWith('mcp__')) {
    const rest = toolName.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    if (sep > 0) return `${rest.slice(0, sep)} / ${rest.slice(sep + 2)}`;
  }
  return toolName;
}

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

type Block = { type?: string; [k: string]: unknown };

function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

/** Text of a tool_result `content`: a string, or the text of its text blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocksOf(content)
    .filter((b) => b.type === 'text' && typeof b['text'] === 'string')
    .map((b) => b['text'] as string)
    .join('\n');
}

function startKind(name: string, input: Record<string, unknown>): StartKind {
  if (SUBAGENT_TOOLS.has(name)) return 'subagent_start';
  if (name === 'Bash' && input['run_in_background'] === true) return 'background_start';
  return 'tool_start';
}

/** One SDK message → zero or more game events. Unknown message types and subtypes yield `[]`. */
export function translate(msg: SDKMessage, ctx: TranslateContext): GameEvent[] {
  const m = msg as unknown as Record<string, unknown>;
  const sessionId = typeof m['session_id'] === 'string' ? m['session_id'] : '';
  const parentToolUseId = (m['parent_tool_use_id'] as string | null | undefined) ?? null;
  const make = (kind: GameEventKind, label: string, extra: Partial<GameEvent> = {}): GameEvent => {
    const e: GameEvent = { id: randomUUID(), sessionId, npcId: ctx.npcId, at: Date.now(), kind, label: truncate(label, LABEL_MAX), ...extra };
    if (ctx.questId !== undefined) e.questId = ctx.questId;
    if (e.detail !== undefined) e.detail = truncate(e.detail, DETAIL_MAX);
    return e;
  };

  switch (msg.type) {
    case 'assistant': {
      const events: GameEvent[] = [];
      for (const b of blocksOf((m['message'] as { content?: unknown } | undefined)?.content)) {
        if (b.type === 'text' && typeof b['text'] === 'string' && b['text'].trim() !== '') {
          events.push(make('text', b['text'], { detail: b['text'], parentToolUseId }));
        } else if (b.type === 'tool_use' && typeof b['id'] === 'string' && typeof b['name'] === 'string') {
          const input = (b['input'] ?? {}) as Record<string, unknown>;
          const kind = startKind(b['name'], input);
          const description = typeof input['description'] === 'string' ? input['description'] : undefined;
          const label = kind === 'subagent_start' && description ? description : summarizeTool(b['name'], input);
          ctx.tracker?.set(b['id'], { kind, label });
          events.push(make(kind, label, { detail: b['name'], toolUseId: b['id'], parentToolUseId }));
        }
      }
      return events;
    }
    case 'user': {
      const events: GameEvent[] = [];
      for (const b of blocksOf((m['message'] as { content?: unknown } | undefined)?.content)) {
        if (b.type !== 'tool_result' || typeof b['tool_use_id'] !== 'string') continue;
        const started = ctx.tracker?.get(b['tool_use_id']);
        ctx.tracker?.delete(b['tool_use_id']);
        const kind = started ? END_KIND[started.kind] : 'tool_end';
        const base = started?.label ?? '工具完成';
        const label = b['is_error'] === true ? `${base}（失敗）` : base;
        events.push(make(kind, label, { detail: resultText(b['content']), toolUseId: b['tool_use_id'], parentToolUseId }));
      }
      return events;
    }
    case 'system':
      if (m['subtype'] === 'compact_boundary') return [make('compact', '正在整理筆記')];
      return [];
    case 'result': {
      const ok = m['subtype'] === 'success' && m['is_error'] !== true;
      const text = typeof m['result'] === 'string' ? m['result'] : '';
      if (ok) return [make('result', '冒險回報', { detail: text })];
      const errors = Array.isArray(m['errors']) ? (m['errors'] as string[]) : [];
      return [make('error', '冒險失敗', { detail: errors.length > 0 ? errors.join('\n') : text || String(m['subtype']) })];
    }
    default:
      return [];
  }
}
