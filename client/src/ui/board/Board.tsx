import { useState } from 'react';
import { BOARD_COLUMNS, STATUS_LABEL, type Quest } from '@loc/shared';
import { useGame } from '../../state/store';
import { NewQuestDialog } from './NewQuestDialog';
import { QuestCard } from './QuestCard';
import { StartQuestDialog } from './StartQuestDialog';

interface BoardProps {
  /** 退回: Task 16 passes the handler that opens the reject dialog. */
  onReject?: (quest: Quest) => void;
}

type Dialog = { kind: 'new'; mode: 'local' | 'jira' } | { kind: 'start'; questId: string };

export function Board({ onReject = () => undefined }: BoardProps) {
  const quests = useGame((s) => s.quests);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);

  const startQuest = dialog?.kind === 'start' ? quests[dialog.questId] : undefined;

  return (
    <section aria-label="佈告欄" className="board">
      <div className="board-actions">
        <button type="button" className="primary" onClick={() => setDialog({ kind: 'new', mode: 'local' })}>
          貼新委託
        </button>
        <button type="button" onClick={() => setDialog({ kind: 'new', mode: 'jira' })}>
          從 Jira 匯入
        </button>
      </div>
      <div className="board-cols">
        {BOARD_COLUMNS.map((status) => {
          const list = Object.values(quests)
            .filter((q) => q.status === status)
            .sort((a, b) => b.updatedAt - a.updatedAt);
          return (
            <section key={status} className="board-col" aria-labelledby={`col-${status}`}>
              <h2 id={`col-${status}`} className="col-title">
                {STATUS_LABEL[status]}
                <span className="col-count">（{list.length}）</span>
              </h2>
              {list.map((q) => (
                <QuestCard
                  key={q.id}
                  quest={q}
                  onDispatch={(quest) => setDialog({ kind: 'start', questId: quest.id })}
                  onReject={onReject}
                />
              ))}
            </section>
          );
        })}
      </div>
      {dialog?.kind === 'new' && <NewQuestDialog initialMode={dialog.mode} onClose={close} />}
      {startQuest && <StartQuestDialog quest={startQuest} onClose={close} />}
    </section>
  );
}
