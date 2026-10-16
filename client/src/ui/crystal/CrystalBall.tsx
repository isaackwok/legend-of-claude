import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionListItem } from '@loc/shared';
import { api } from '../../api/http';
import { useGame } from '../../state/store';
import { Composer, type ComposerMode } from './Composer';
import { PigeonLetter } from './PigeonLetter';
import { SessionList } from './SessionList';
import { Transcript } from './Transcript';

export function CrystalBall() {
  const selectedId = useGame((s) => s.ui.crystalSessionId);
  const npcs = useGame((s) => s.npcs);
  const quests = useGame((s) => s.quests);
  const approvalMap = useGame((s) => s.approvals);
  const events = useGame((s) => s.events);
  const openCrystal = useGame((s) => s.openCrystal);

  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState<string>();
  const [draftNpcId, setDraftNpcId] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const requestSeq = useRef(0);
  const requestedUnknown = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const list = await api<SessionListItem[]>('/sessions');
      if (seq !== requestSeq.current) return;
      setSessions(list);
      setListError(undefined);
    } catch (err) {
      if (seq === requestSeq.current) setListError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === requestSeq.current) setLoaded(true);
    }
  }, []);

  // Fetch on open (no polling).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Refetch when a session finishes or a quest's session changes status (live flag, updatedAt).
  const settledKey = useMemo(() => {
    const terminal = Object.values(events).reduce(
      (n, list) => n + list.filter((e) => e.kind === 'result' || e.kind === 'error').length,
      0,
    );
    const questKey = Object.values(quests)
      .map((q) => `${q.sessionId ?? ''}:${q.status}`)
      .join(',');
    return `${terminal}|${questKey}`;
  }, [events, quests]);
  const firstSettled = useRef(true);
  useEffect(() => {
    if (firstSettled.current) {
      firstSettled.current = false;
      return;
    }
    void refresh();
  }, [settledKey, refresh]);

  // Refetch when a session id we do not know yet shows up (once per id).
  useEffect(() => {
    if (!loaded) return;
    const known = new Set(sessions.map((s) => s.id));
    const unknown = Object.keys(events).filter((id) => !known.has(id) && !requestedUnknown.current.has(id));
    if (unknown.length === 0) return;
    for (const id of unknown) requestedUnknown.current.add(id);
    void refresh();
  }, [events, sessions, loaded, refresh]);

  const approvals = useMemo(() => Object.values(approvalMap).sort((a, b) => a.createdAt - b.createdAt), [approvalMap]);
  const selected = selectedId ? sessions.find((s) => s.id === selectedId) : undefined;
  const selectedQuest = selectedId
    ? quests[selected?.questId ?? ''] ?? Object.values(quests).find((q) => q.sessionId === selectedId)
    : undefined;
  const letters = selectedId ? approvals.filter((a) => a.sessionId === selectedId) : [];

  const select = (sessionId: string) => {
    setDraftNpcId(undefined);
    openCrystal(sessionId);
  };

  let composer: ComposerMode | undefined;
  let heading = '';
  if (draftNpcId) {
    heading = `與 ${npcs[draftNpcId]?.name ?? draftNpcId} 聊天`;
    composer = { kind: 'chat', npcId: draftNpcId };
  } else if (selectedId) {
    heading = selected?.title ?? selectedQuest?.title ?? '冒險日誌';
    if (selectedQuest) {
      composer =
        selectedQuest.status === 'adventuring'
          ? { kind: 'quest', questId: selectedQuest.id }
          : { kind: 'readonly', notice: '這趟冒險已經結束，日誌只能閱讀。' };
    } else if (selected && !selected.questId) {
      composer = { kind: 'chat', npcId: selected.npcId, sessionId: selected.id };
    }
  }

  const onSent = (sessionId?: string) => {
    setRefreshKey((k) => k + 1);
    if (sessionId) {
      void refresh();
      if (draftNpcId) {
        setDraftNpcId(undefined);
        openCrystal(sessionId);
      }
    }
  };

  return (
    <div className="crystal">
      <SessionList
        sessions={sessions}
        npcs={npcs}
        approvals={approvals}
        selectedId={draftNpcId ? undefined : selectedId}
        draftNpcId={draftNpcId}
        onSelect={select}
        onStartChat={setDraftNpcId}
      />
      <section className="crystal-main frame" aria-label="水晶球">
        {listError && (
          <p className="form-error" role="alert">
            讀取列表失敗：{listError}
          </p>
        )}
        {!draftNpcId && !selectedId && <p className="crystal-empty">從左邊選一段冒險日誌，或與 NPC 聊天。</p>}
        {heading && <h2 className="crystal-heading">{heading}</h2>}
        {!draftNpcId && selectedId && <Transcript key={`t-${selectedId}`} sessionId={selectedId} refreshKey={refreshKey} />}
        {draftNpcId && <div className="transcript"><p className="crystal-empty">送出第一句話，就會開啟一段新的閒聊。</p></div>}
        {letters.map((a) => (
          <PigeonLetter key={a.id} approval={a} />
        ))}
        {composer && <Composer key={`c-${draftNpcId ?? selectedId}`} mode={composer} onSent={onSent} />}
      </section>
    </div>
  );
}
