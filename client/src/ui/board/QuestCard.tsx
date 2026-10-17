import { useState } from 'react';
import type { Quest } from '@loc/shared';
import { api } from '../../api/http';
import { useGame } from '../../state/store';

interface QuestCardProps {
  quest: Quest;
  /** 派遣: open the start dialog for this quest. */
  onDispatch: (quest: Quest) => void;
  /** 退回: Task 16 wires the reject dialog here. */
  onReject: (quest: Quest) => void;
}

export function QuestCard({ quest, onDispatch, onReject }: QuestCardProps) {
  const npc = useGame((s) => (quest.npcId ? s.npcs[quest.npcId] : undefined));
  const dungeon = useGame((s) => (quest.dungeonId ? s.dungeons[quest.dungeonId] : undefined));
  const latest = useGame((s) => {
    const list = quest.sessionId ? s.events[quest.sessionId] : undefined;
    return list?.[list.length - 1]?.label;
  });
  const openCrystal = useGame((s) => s.openCrystal);
  const openSettlement = useGame((s) => s.openSettlement);
  const [error, setError] = useState<string>();

  const abandon = async () => {
    if (!confirm(`確定要放棄「${quest.title}」嗎？`)) return;
    setError(undefined);
    try {
      const updated = await api<Quest>(`/quests/${quest.id}/abandon`, { method: 'POST' });
      useGame.getState().applyServerMessage({ type: 'quest', quest: updated });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const ticket = quest.source.kind === 'jira' ? quest.source.key : '本地委託';
  const canAbandon = quest.status === 'open' || quest.status === 'review';

  return (
    <article className="note" data-status={quest.status}>
      <div className="note-id">{ticket}</div>
      <h3 className="note-title">{quest.title}</h3>
      <div className="note-stars" role="img" aria-label={`${quest.stars} 星`}>
        {'★'.repeat(quest.stars)}
      </div>
      {dungeon && <div className="note-who">地下城：{dungeon.name}</div>}
      {npc && (
        <div className="note-who">
          冒險者：{npc.name}
          {quest.status === 'adventuring' && <span className="note-live">　冒險中：{latest ?? '準備出發'}</span>}
        </div>
      )}
      <div className="note-actions">
        {quest.status === 'open' && (
          <button type="button" onClick={() => onDispatch(quest)}>
            派遣
          </button>
        )}
        {quest.status === 'adventuring' && quest.sessionId && (
          <button type="button" onClick={() => openCrystal(quest.sessionId!)}>
            觀看冒險
          </button>
        )}
        {quest.status === 'review' && (
          <>
            <button type="button" className="primary" onClick={() => openSettlement(quest.id)}>
              驗收
            </button>
            <button type="button" onClick={() => onReject(quest)}>
              退回
            </button>
          </>
        )}
        {canAbandon && (
          <button type="button" className="quiet" onClick={abandon}>
            放棄
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="note-error">
          {error}
        </p>
      )}
    </article>
  );
}
