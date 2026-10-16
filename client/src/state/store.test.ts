import { beforeEach, describe, expect, it } from 'vitest';
import type { Approval, Dungeon, GameEvent, Npc, Quest } from '@loc/shared';
import { EVENT_CAP, initialState, useGame } from './store';

const quest = (id: string, title = 't'): Quest => ({
  id, title, body: '', stars: 1, status: 'open', source: { kind: 'local' }, rejections: 0, createdAt: 1, updatedAt: 1,
});
const npc = (id: string): Npc => ({
  id, name: id, classId: 'warrior', persona: '', model: 'm', effort: 'low',
  equipment: { connectorPrefixes: [], readOnly: false }, skills: [],
});
const dungeon = (id: string): Dungeon => ({ id, name: id, path: `/tmp/${id}` });
const approval = (id: string): Approval => ({ id, npcId: 'n1', sessionId: 's1', toolName: 'Bash', summary: 'x', createdAt: 1 });
const ev = (id: string, sessionId: string): GameEvent => ({ id, sessionId, npcId: 'n1', at: 1, kind: 'text', label: id });

beforeEach(() => useGame.setState(initialState()));

describe('game store', () => {
  it('snapshot fills every collection', () => {
    useGame.getState().applyServerMessage({
      type: 'snapshot',
      quests: [quest('q1'), quest('q2')],
      npcs: [npc('n1')],
      dungeons: [dungeon('d1')],
      approvals: [approval('a1')],
      preflight: { ignoredEnvVars: ['ANTHROPIC_API_KEY'], loggedIn: true, warnings: [] },
    });
    const s = useGame.getState();
    expect(Object.keys(s.quests)).toEqual(['q1', 'q2']);
    expect(Object.keys(s.npcs)).toEqual(['n1']);
    expect(Object.keys(s.dungeons)).toEqual(['d1']);
    expect(Object.keys(s.approvals)).toEqual(['a1']);
    expect(s.preflight?.ignoredEnvVars).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('snapshot replaces earlier state (reconnect) but keeps events', () => {
    const g = useGame.getState();
    g.applyServerMessage({ type: 'quest', quest: quest('old') });
    g.applyServerMessage({ type: 'event', event: ev('e1', 's1') });
    g.applyServerMessage({ type: 'snapshot', quests: [quest('q1')], npcs: [], dungeons: [], approvals: [], preflight: { ignoredEnvVars: [], loggedIn: true, warnings: [] } });
    const s = useGame.getState();
    expect(Object.keys(s.quests)).toEqual(['q1']);
    expect(s.events['s1']).toHaveLength(1);
  });

  it('quest message overwrites the same id', () => {
    const g = useGame.getState();
    g.applyServerMessage({ type: 'quest', quest: quest('q1', 'old') });
    g.applyServerMessage({ type: 'quest', quest: quest('q1', 'new') });
    expect(useGame.getState().quests['q1']?.title).toBe('new');
    expect(Object.keys(useGame.getState().quests)).toHaveLength(1);
  });

  it('npc and dungeon messages upsert', () => {
    const g = useGame.getState();
    g.applyServerMessage({ type: 'npc', npc: npc('n1') });
    g.applyServerMessage({ type: 'dungeon', dungeon: dungeon('d1') });
    expect(useGame.getState().npcs['n1']).toBeDefined();
    expect(useGame.getState().dungeons['d1']).toBeDefined();
  });

  it('approval is added and approval_resolved removes it', () => {
    const g = useGame.getState();
    g.applyServerMessage({ type: 'approval', approval: approval('a1') });
    expect(useGame.getState().approvals['a1']).toBeDefined();
    g.applyServerMessage({ type: 'approval_resolved', id: 'a1' });
    expect(useGame.getState().approvals['a1']).toBeUndefined();
    g.applyServerMessage({ type: 'approval_resolved', id: 'missing' });
  });

  it('events accumulate per session and drop the oldest past the cap', () => {
    const g = useGame.getState();
    g.applyServerMessage({ type: 'event', event: ev('o1', 's2') });
    for (let i = 0; i < EVENT_CAP + 5; i++) g.applyServerMessage({ type: 'event', event: ev(`e${i}`, 's1') });
    const s = useGame.getState();
    expect(s.events['s1']).toHaveLength(500);
    expect(s.events['s1']?.[0]?.id).toBe('e5');
    expect(s.events['s1']?.at(-1)?.id).toBe(`e${EVENT_CAP + 4}`);
    expect(s.events['s2']).toHaveLength(1);
  });

  it('setDungeons and removeDungeon manage dungeons', () => {
    const g = useGame.getState();
    g.setDungeons([dungeon('d1'), dungeon('d2')]);
    expect(Object.keys(useGame.getState().dungeons)).toEqual(['d1', 'd2']);
    g.removeDungeon('d1');
    expect(Object.keys(useGame.getState().dungeons)).toEqual(['d2']);
  });

  it('ui actions', () => {
    const g = useGame.getState();
    expect(useGame.getState().ui.panel).toBe('board');
    g.openCrystal('s9');
    expect(useGame.getState().ui).toMatchObject({ panel: 'crystal', crystalSessionId: 's9' });
    g.openSettlement('q1');
    expect(useGame.getState().ui.settlementQuestId).toBe('q1');
    g.closeSettlement();
    expect(useGame.getState().ui.settlementQuestId).toBeUndefined();
    g.openPanel('dungeons');
    expect(useGame.getState().ui.panel).toBe('dungeons');
  });
});
