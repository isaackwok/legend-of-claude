import { useMemo, useState, type FormEvent } from 'react';
import type { Npc, Quest } from '@loc/shared';
import { api } from '../../api/http';
import { useGame } from '../../state/store';
import { Modal } from '../Modal';

interface StartQuestDialogProps {
  quest: Quest;
  onClose: () => void;
}

export function StartQuestDialog({ quest, onClose }: StartQuestDialogProps) {
  const npcMap = useGame((s) => s.npcs);
  const dungeonMap = useGame((s) => s.dungeons);
  // The guild clerk only does paperwork, and a busy NPC can hold only one quest at a time.
  const npcs = useMemo(
    () => Object.values(npcMap).filter((n) => !n.builtin && !n.busyQuestId).sort((a, b) => a.name.localeCompare(b.name)),
    [npcMap],
  );
  const dungeons = useMemo(() => Object.values(dungeonMap).sort((a, b) => a.name.localeCompare(b.name)), [dungeonMap]);

  const defaultDungeon = (npc: Npc | undefined) =>
    npc?.homeDungeonId && dungeonMap[npc.homeDungeonId] ? npc.homeDungeonId : (dungeons[0]?.id ?? '');

  const [npcId, setNpcId] = useState(npcs[0]?.id ?? '');
  const [dungeonId, setDungeonId] = useState(() => defaultDungeon(npcs[0]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const chooseNpc = (id: string) => {
    setNpcId(id);
    const npc = npcs.find((n) => n.id === id);
    if (npc?.homeDungeonId && dungeonMap[npc.homeDungeonId]) setDungeonId(npc.homeDungeonId);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const updated = await api<Quest>(`/quests/${quest.id}/start`, {
        method: 'POST',
        body: JSON.stringify({ npcId, dungeonId }),
      });
      useGame.getState().applyServerMessage({ type: 'quest', quest: updated });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`派遣冒險者：${quest.title}`} onClose={onClose}>
      <form onSubmit={submit} className="form">
        {npcs.length === 0 && <p>目前沒有空閒的冒險者。</p>}
        {dungeons.length === 0 && <p>尚未登記地下城，請先到「地下城地圖」登記。</p>}
        <label>
          冒險者
          <select value={npcId} onChange={(e) => chooseNpc(e.target.value)} disabled={busy || npcs.length === 0}>
            {npcs.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          地下城
          <select value={dungeonId} onChange={(e) => setDungeonId(e.target.value)} disabled={busy || dungeons.length === 0}>
            {dungeons.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        {error && <p role="alert" className="form-error">{error}</p>}
        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy || !npcId || !dungeonId}>
            出發
          </button>
          <button type="button" className="quiet" onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </Modal>
  );
}
