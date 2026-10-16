import { create } from 'zustand';
import type { Approval, Dungeon, GameEvent, Npc, Preflight, Quest, ServerMessage } from '@loc/shared';

/** Events kept per session; the oldest are dropped first. */
export const EVENT_CAP = 500;

export type PanelId = 'board' | 'crystal' | 'dungeons';

export interface UiState {
  panel: PanelId;
  crystalSessionId?: string;
  settlementQuestId?: string;
}

export interface GameState {
  quests: Record<string, Quest>;
  npcs: Record<string, Npc>;
  dungeons: Record<string, Dungeon>;
  approvals: Record<string, Approval>;
  events: Record<string, GameEvent[]>;
  preflight: Preflight | null;
  ui: UiState;
  applyServerMessage: (msg: ServerMessage) => void;
  setDungeons: (list: Dungeon[]) => void;
  removeDungeon: (id: string) => void;
  setPreflight: (p: Preflight) => void;
  openPanel: (panel: PanelId) => void;
  openCrystal: (sessionId: string) => void;
  openSettlement: (questId: string) => void;
  closeSettlement: () => void;
}

type Data = Pick<GameState, 'quests' | 'npcs' | 'dungeons' | 'approvals' | 'events' | 'preflight' | 'ui'>;

export function initialState(): Data {
  return { quests: {}, npcs: {}, dungeons: {}, approvals: {}, events: {}, preflight: null, ui: { panel: 'board' } };
}

function byId<T extends { id: string }>(list: T[]): Record<string, T> {
  return Object.fromEntries(list.map((x) => [x.id, x]));
}

// Plain Zustand store: Phaser (later) reads it via useGame.getState() / useGame.subscribe().
export const useGame = create<GameState>()((set) => ({
  ...initialState(),

  applyServerMessage: (msg) =>
    set((s) => {
      switch (msg.type) {
        case 'snapshot':
          // Events are not part of the snapshot; keep what we have across a reconnect.
          return {
            quests: byId(msg.quests),
            npcs: byId(msg.npcs),
            dungeons: byId(msg.dungeons),
            approvals: byId(msg.approvals),
            preflight: msg.preflight,
          };
        case 'quest':
          return { quests: { ...s.quests, [msg.quest.id]: msg.quest } };
        case 'npc':
          return { npcs: { ...s.npcs, [msg.npc.id]: msg.npc } };
        case 'dungeon':
          return { dungeons: { ...s.dungeons, [msg.dungeon.id]: msg.dungeon } };
        case 'approval':
          return { approvals: { ...s.approvals, [msg.approval.id]: msg.approval } };
        case 'approval_resolved': {
          if (!(msg.id in s.approvals)) return {};
          const { [msg.id]: _gone, ...rest } = s.approvals;
          return { approvals: rest };
        }
        case 'event': {
          const sid = msg.event.sessionId;
          const next = [...(s.events[sid] ?? []), msg.event];
          if (next.length > EVENT_CAP) next.splice(0, next.length - EVENT_CAP);
          return { events: { ...s.events, [sid]: next } };
        }
      }
    }),

  setDungeons: (list) => set({ dungeons: byId(list) }),
  removeDungeon: (id) =>
    set((s) => {
      const { [id]: _gone, ...rest } = s.dungeons;
      return { dungeons: rest };
    }),
  setPreflight: (preflight) => set({ preflight }),

  openPanel: (panel) => set((s) => ({ ui: { ...s.ui, panel } })),
  openCrystal: (sessionId) => set((s) => ({ ui: { ...s.ui, panel: 'crystal', crystalSessionId: sessionId } })),
  openSettlement: (questId) => set((s) => ({ ui: { ...s.ui, settlementQuestId: questId } })),
  closeSettlement: () =>
    set((s) => {
      const { settlementQuestId: _gone, ...ui } = s.ui;
      return { ui };
    }),
}));
