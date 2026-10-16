import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameEvent, TranscriptMessage } from '@loc/shared';
import { api } from '../../api/http';
import { useGame } from '../../state/store';

const EMPTY: GameEvent[] = [];
const MAX_CHARS = 4000;

function clip(text: string): string {
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…（已截斷）` : text;
}

function prettyJson(value: unknown): string {
  try {
    return clip(JSON.stringify(value, null, 2) ?? '');
  } catch {
    return '（無法顯示）';
  }
}

function DiffLines({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = [
    ...(oldText === '' ? [] : oldText.split('\n').map((l) => ({ sign: '-', text: l }))),
    ...(newText === '' ? [] : newText.split('\n').map((l) => ({ sign: '+', text: l }))),
  ];
  return (
    <pre className="diff">
      {lines.map((l, i) => (
        <div key={i} className={l.sign === '-' ? 'diff-del' : 'diff-add'}>
          {l.sign} {l.text}
        </div>
      ))}
    </pre>
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function ToolInput({ name, input }: { name: string; input: Record<string, unknown> }) {
  if (name === 'Edit' && typeof input['old_string'] === 'string' && typeof input['new_string'] === 'string') {
    return (
      <>
        {typeof input['file_path'] === 'string' && <div className="tool-path">{input['file_path']}</div>}
        <DiffLines oldText={clip(input['old_string'])} newText={clip(input['new_string'])} />
      </>
    );
  }
  if (name === 'MultiEdit' && Array.isArray(input['edits'])) {
    return (
      <>
        {typeof input['file_path'] === 'string' && <div className="tool-path">{input['file_path']}</div>}
        {input['edits'].map((e, i) =>
          isRecord(e) && typeof e['old_string'] === 'string' && typeof e['new_string'] === 'string' ? (
            <DiffLines key={i} oldText={clip(e['old_string'])} newText={clip(e['new_string'])} />
          ) : (
            <pre key={i}>{prettyJson(e)}</pre>
          ),
        )}
      </>
    );
  }
  return <pre className="tool-json">{prettyJson(input)}</pre>;
}

interface ToolRowProps {
  label: string;
  prefix?: string;
  running?: boolean;
  failed?: boolean;
  nested?: boolean;
  children: React.ReactNode;
}

function ToolRow({ label, prefix, running, failed, nested, children }: ToolRowProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tool${nested ? ' tool-nested' : ''}${failed ? ' tool-failed' : ''}`}>
      <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {prefix && <span className="tool-prefix">{prefix}　</span>}
        <span>{label}</span>
        {running && <span className="tool-running">　進行中</span>}
      </button>
      {open && <div className="tool-body">{children}</div>}
    </div>
  );
}

type LiveItem =
  | { kind: 'text'; id: string; text: string; nested: boolean }
  | { kind: 'compact'; id: string }
  | { kind: 'tool'; id: string; group: 'tool' | 'subagent' | 'background'; start?: GameEvent; end?: GameEvent; nested: boolean }
  | { kind: 'result' | 'error'; id: string; label: string; text: string };

const GROUP_PREFIX = { tool: undefined, subagent: '使魔', background: '營火' } as const;

function groupOf(kind: GameEvent['kind']): 'tool' | 'subagent' | 'background' {
  return kind.startsWith('subagent') ? 'subagent' : kind.startsWith('background') ? 'background' : 'tool';
}

/** Pairs `*_start` with its `*_end` (same toolUseId) so one tool call is one row. */
export function buildLiveItems(events: GameEvent[]): LiveItem[] {
  const items: LiveItem[] = [];
  const open = new Map<string, Extract<LiveItem, { kind: 'tool' }>>();
  for (const e of events) {
    const nested = e.parentToolUseId != null;
    switch (e.kind) {
      case 'text':
        items.push({ kind: 'text', id: e.id, text: e.detail ?? e.label, nested });
        break;
      case 'compact':
        items.push({ kind: 'compact', id: e.id });
        break;
      case 'tool_start':
      case 'subagent_start':
      case 'background_start': {
        const item: Extract<LiveItem, { kind: 'tool' }> = { kind: 'tool', id: e.id, group: groupOf(e.kind), start: e, nested };
        items.push(item);
        if (e.toolUseId) open.set(e.toolUseId, item);
        break;
      }
      case 'tool_end':
      case 'subagent_end':
      case 'background_end': {
        const match = e.toolUseId ? open.get(e.toolUseId) : undefined;
        if (match) match.end = e;
        else items.push({ kind: 'tool', id: e.id, group: groupOf(e.kind), end: e, nested });
        break;
      }
      case 'result':
        items.push({ kind: 'result', id: e.id, label: e.label, text: e.detail ?? '' });
        break;
      case 'error':
        items.push({ kind: 'error', id: e.id, label: e.label, text: e.detail ?? '' });
        break;
    }
  }
  return items;
}

function LiveItemView({ item }: { item: LiveItem }) {
  switch (item.kind) {
    case 'text':
      return <p className={`msg msg-assistant${item.nested ? ' tool-nested' : ''}`}>{item.text}</p>;
    case 'compact':
      return <div className="divider">正在整理筆記</div>;
    case 'result':
      return (
        <div className="msg msg-result">
          <strong>{item.label}</strong>
          {item.text && <p>{item.text}</p>}
        </div>
      );
    case 'error':
      return (
        <div className="msg msg-error" role="alert">
          <strong>{item.label}</strong>
          {item.text && <p>{item.text}</p>}
        </div>
      );
    case 'tool': {
      const label = item.start?.label ?? item.end?.label ?? '';
      const failed = item.end?.label.endsWith('（失敗）') ?? false;
      return (
        <ToolRow label={label} prefix={GROUP_PREFIX[item.group]} running={!item.end} failed={failed} nested={item.nested}>
          {item.start?.detail && <div className="tool-path">工具：{item.start.detail}</div>}
          {item.end?.detail ? <pre className="tool-output">{clip(item.end.detail)}</pre> : item.end ? <p>（沒有輸出）</p> : <p>尚未完成</p>}
        </ToolRow>
      );
    }
  }
}

function HistoryView({ messages }: { messages: TranscriptMessage[] }) {
  const results = useMemo(() => {
    const map = new Map<string, { isError: boolean; output: string }>();
    for (const m of messages) for (const b of m.blocks) if (b.type === 'tool_result') map.set(b.toolUseId, b);
    return map;
  }, [messages]);
  const usedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of messages) for (const b of m.blocks) if (b.type === 'tool_use') ids.add(b.id);
    return ids;
  }, [messages]);

  return (
    <>
      {messages.map((m, mi) =>
        m.blocks.map((b, bi) => {
          const key = `${mi}-${bi}`;
          if (b.type === 'text') {
            return (
              <p key={key} className={`msg ${m.role === 'user' ? 'msg-user' : 'msg-assistant'}`}>
                {m.role === 'user' && <strong>會長：</strong>}
                {b.text}
              </p>
            );
          }
          if (b.type === 'tool_use') {
            const result = results.get(b.id);
            return (
              <ToolRow key={key} label={`${b.name}　${b.summary}`} failed={result?.isError}>
                <ToolInput name={b.name} input={b.input} />
                {result ? <pre className="tool-output">{clip(result.output)}</pre> : <p>（沒有輸出）</p>}
              </ToolRow>
            );
          }
          if (usedIds.has(b.toolUseId)) return null; // shown under its tool call
          return (
            <ToolRow key={key} label="工具輸出" failed={b.isError}>
              <pre className="tool-output">{clip(b.output)}</pre>
            </ToolRow>
          );
        }),
      )}
    </>
  );
}

interface TranscriptProps {
  sessionId: string;
  /** Bump to force a history refetch (e.g. right after sending a message). */
  refreshKey?: number;
}

export function Transcript({ sessionId, refreshKey = 0 }: TranscriptProps) {
  const live = useGame((s) => s.events[sessionId] ?? EMPTY);
  const [history, setHistory] = useState<{ sessionId: string; messages: TranscriptMessage[]; fetchedAt: number }>();
  const [error, setError] = useState<string>();
  const endRef = useRef<HTMLDivElement>(null);

  // A result/error event means the agent persisted new history: refetch it.
  const terminalId = useMemo(() => {
    for (let i = live.length - 1; i >= 0; i--) {
      const e = live[i];
      if (e && (e.kind === 'result' || e.kind === 'error')) return e.id;
    }
    return '';
  }, [live]);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    setError(undefined);
    api<TranscriptMessage[]>(`/sessions/${encodeURIComponent(sessionId)}/messages`).then(
      (messages) => {
        if (!cancelled) setHistory({ sessionId, messages, fetchedAt: startedAt });
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, terminalId, refreshKey]);

  const loaded = history?.sessionId === sessionId ? history : undefined;
  // Live events older than the history fetch are already part of the history.
  const cutoff = loaded ? loaded.fetchedAt : error ? 0 : Number.POSITIVE_INFINITY;
  const items = useMemo(() => buildLiveItems(live.filter((e) => e.at > cutoff)), [live, cutoff]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [loaded, items.length]);

  return (
    <div className="transcript" aria-label="冒險日誌">
      {!loaded && !error && <p className="crystal-empty">讀取冒險日誌中…</p>}
      {error && <p className="crystal-empty">讀取歷史失敗：{error}</p>}
      {loaded && <HistoryView messages={loaded.messages} />}
      {items.map((item) => (
        <LiveItemView key={item.id} item={item} />
      ))}
      <div ref={endRef} />
    </div>
  );
}
