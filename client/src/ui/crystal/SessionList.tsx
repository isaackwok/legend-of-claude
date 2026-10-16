import { useMemo, useState } from 'react';
import type { Approval, Npc, SessionListItem } from '@loc/shared';

interface SessionListProps {
  sessions: SessionListItem[];
  npcs: Record<string, Npc>;
  approvals: Approval[];
  selectedId?: string;
  /** NPC chosen for a not-yet-started chat. */
  draftNpcId?: string;
  onSelect: (sessionId: string) => void;
  onStartChat: (npcId: string) => void;
}

interface Group {
  npcId: string;
  items: SessionListItem[];
}

export function SessionList({ sessions, npcs, approvals, selectedId, draftNpcId, onSelect, onStartChat }: SessionListProps) {
  const [choosing, setChoosing] = useState(false);

  const groups = useMemo(() => {
    const byNpc = new Map<string, SessionListItem[]>();
    for (const s of sessions) byNpc.set(s.npcId, [...(byNpc.get(s.npcId) ?? []), s]);
    const out: Group[] = [];
    for (const [npcId, items] of byNpc) {
      // Live sessions first; Array.sort is stable so the server's order is kept otherwise.
      out.push({ npcId, items: [...items].sort((a, b) => Number(b.live) - Number(a.live)) });
    }
    return out;
  }, [sessions]);

  const nameOf = (npcId: string) => npcs[npcId]?.name ?? npcId;
  const chatNpcs = Object.values(npcs).filter((n) => !n.builtin);

  return (
    <aside className="crystal-side" aria-label="冒險日誌列表">
      <section className="crystal-mailbox" aria-label="信箱">
        <h3>信箱</h3>
        {approvals.length === 0 ? (
          <p className="crystal-empty">沒有待批准的信</p>
        ) : (
          <ul className="crystal-list">
            {approvals.map((a) => (
              <li key={a.id}>
                <button type="button" className="crystal-item" onClick={() => onSelect(a.sessionId)}>
                  <span className="crystal-item-title">{nameOf(a.npcId)}</span>
                  <span className="crystal-item-sub">{a.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="crystal-chat-start">
        <button type="button" onClick={() => setChoosing((v) => !v)} aria-expanded={choosing}>
          與 NPC 聊天
        </button>
        {choosing && (
          <select
            aria-label="選擇聊天對象"
            value={draftNpcId ?? ''}
            onChange={(e) => {
              if (e.target.value) {
                onStartChat(e.target.value);
                setChoosing(false);
              }
            }}
          >
            <option value="">選擇 NPC</option>
            {chatNpcs.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {groups.length === 0 && <p className="crystal-empty">還沒有冒險日誌</p>}
      {groups.map((g) => (
        <section key={g.npcId} className="crystal-group" aria-label={nameOf(g.npcId)}>
          <h3>{nameOf(g.npcId)}</h3>
          <ul className="crystal-list">
            {g.items.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="crystal-item"
                  aria-current={s.id === selectedId ? 'true' : undefined}
                  onClick={() => onSelect(s.id)}
                >
                  <span className="crystal-item-title">
                    {s.live && <span className="note-live">冒險中　</span>}
                    {s.title}
                  </span>
                  <span className="crystal-item-sub">{s.questId ? '委託' : '閒聊'}　{new Date(s.updatedAt).toLocaleString('zh-TW')}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
