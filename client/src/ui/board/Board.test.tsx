import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Dungeon, GameEvent, Npc, Quest } from '@loc/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState, useGame } from '../../state/store';
import { Board } from './Board';
import { StartQuestDialog } from './StartQuestDialog';

const quest = (over: Partial<Quest> & Pick<Quest, 'id' | 'status'>): Quest => ({
  title: `標題 ${over.id}`, body: '', stars: 2, source: { kind: 'local' }, rejections: 0, createdAt: 1, updatedAt: 1, ...over,
});
const npc = (over: Partial<Npc> & Pick<Npc, 'id' | 'name'>): Npc => ({
  classId: 'warrior', persona: '', model: 'm', effort: 'medium', equipment: { connectorPrefixes: [], readOnly: false }, skills: [], ...over,
});
const dungeon = (id: string, name: string): Dungeon => ({ id, name, path: `/dev/${name}` });
const event = (sessionId: string, label: string, at: number): GameEvent => ({ id: `${sessionId}-${at}`, sessionId, npcId: 'n1', at, kind: 'tool_start', label });

function mockFetch(handler: (path: string, init: RequestInit) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>) {
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const { status = 200, body } = await handler(String(url).replace(/^\/api/, ''), init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  sessionStorage.setItem('loc.token', 'test-token');
  useGame.setState(initialState());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('Board', () => {
  it('puts quests in the column of their status, titled by STATUS_LABEL', () => {
    useGame.setState({
      quests: {
        a: quest({ id: 'a', status: 'open' }),
        b: quest({ id: 'b', status: 'adventuring', npcId: 'n1', sessionId: 's1' }),
        c: quest({ id: 'c', status: 'review' }),
      },
    });
    render(<Board />);
    const col = (name: string) => within(screen.getByRole('region', { name: new RegExp(name) }));
    expect(col('待接委託').getByText('標題 a')).toBeTruthy();
    expect(col('冒險中').getByText('標題 b')).toBeTruthy();
    expect(col('待驗收').getByText('標題 c')).toBeTruthy();
    expect(col('已完成').queryByText(/標題/)).toBeNull();
    expect(col('待接委託').queryByText('標題 b')).toBeNull();
  });

  it('review cards offer 驗收 and 退回; 驗收 opens settlement, 退回 calls onReject', () => {
    const q = quest({ id: 'c', status: 'review' });
    useGame.setState({ quests: { c: q } });
    const onReject = vi.fn();
    render(<Board onReject={onReject} />);
    fireEvent.click(screen.getByRole('button', { name: '驗收' }));
    expect(useGame.getState().ui.settlementQuestId).toBe('c');
    fireEvent.click(screen.getByRole('button', { name: '退回' }));
    expect(onReject).toHaveBeenCalledWith(q);
  });

  it('shows the ticket key, stars, dungeon, npc and the latest event of an adventuring quest', () => {
    useGame.setState({
      quests: {
        j: quest({
          id: 'j', status: 'adventuring', stars: 3, npcId: 'n1', dungeonId: 'd1', sessionId: 's1',
          source: { kind: 'jira', key: 'SHOP-482', url: 'https://x/SHOP-482' },
        }),
        l: quest({ id: 'l', status: 'open' }),
      },
      npcs: { n1: npc({ id: 'n1', name: '亞瑟' }) },
      dungeons: { d1: dungeon('d1', 'shop-api') },
      events: { s1: [event('s1', '讀取檔案', 1), event('s1', '執行測試', 2)] },
    });
    render(<Board />);
    expect(screen.getByText('SHOP-482')).toBeTruthy();
    expect(screen.getByText('本地委託')).toBeTruthy();
    expect(screen.getByRole('img', { name: '3 星' }).textContent).toBe('★★★');
    expect(screen.getByText(/shop-api/)).toBeTruthy();
    expect(screen.getByText(/亞瑟/)).toBeTruthy();
    expect(screen.getByText(/執行測試/)).toBeTruthy();
    expect(screen.queryByText(/讀取檔案/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '觀看冒險' }));
    expect(useGame.getState().ui).toMatchObject({ panel: 'crystal', crystalSessionId: 's1' });
  });

  it('abandons an open quest after confirm and applies the result', async () => {
    useGame.setState({ quests: { a: quest({ id: 'a', status: 'open' }) } });
    const fetchFn = mockFetch((path) => ({ body: quest({ id: 'a', status: 'abandoned' }) }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Board />);
    fireEvent.click(screen.getByRole('button', { name: '放棄' }));
    await waitFor(() => expect(useGame.getState().quests['a']?.status).toBe('abandoned'));
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/quests/a/abandon');
  });

  it('does not abandon when confirm is declined, and done cards have no 放棄', () => {
    useGame.setState({ quests: { a: quest({ id: 'a', status: 'open' }), d: quest({ id: 'd', status: 'done' }) } });
    const fetchFn = mockFetch(() => ({ body: {} }));
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<Board />);
    expect(screen.getAllByRole('button', { name: '放棄' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '放棄' }));
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('creates a local quest from the dialog', async () => {
    const created = quest({ id: 'new', status: 'open', title: '新委託' });
    const fetchFn = mockFetch(() => ({ status: 201, body: created }));
    render(<Board />);
    fireEvent.click(screen.getByRole('button', { name: '貼新委託' }));
    const dialog = screen.getByRole('dialog', { name: '貼新委託' });
    fireEvent.change(within(dialog).getByLabelText('標題'), { target: { value: '新委託' } });
    fireEvent.change(within(dialog).getByLabelText('內容'), { target: { value: '內文' } });
    fireEvent.change(within(dialog).getByLabelText('星等'), { target: { value: '4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '貼上佈告欄' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [path, init] = fetchFn.mock.calls[0]!;
    expect(path).toBe('/api/quests');
    expect(JSON.parse(String(init?.body))).toEqual({ title: '新委託', body: '內文', stars: 4 });
    expect(useGame.getState().quests['new']).toBeTruthy();
  });

  it('Jira import shows the waiting text, then closes on success (including an existing quest, 200)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const existing = quest({ id: 'e', status: 'adventuring', source: { kind: 'jira', key: 'SHOP-1', url: 'u' } });
    const fetchFn = mockFetch(async () => {
      await gate;
      return { status: 200, body: existing };
    });
    render(<Board />);
    fireEvent.click(screen.getByRole('button', { name: '從 Jira 匯入' }));
    const dialog = screen.getByRole('dialog', { name: '從 Jira 匯入委託' });
    fireEvent.change(within(dialog).getByLabelText('Jira 票號'), { target: { value: ' SHOP-1 ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '匯入' }));
    expect(await screen.findByText('公會櫃檯正在查詢…')).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/jira/import');
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({ key: 'SHOP-1' });
    expect(useGame.getState().quests['e']).toBeTruthy();
  });

  it('Jira import shows the server error verbatim and stays open', async () => {
    mockFetch(() => ({ status: 400, body: { error: '找不到票 NOPE-1' } }));
    render(<Board />);
    fireEvent.click(screen.getByRole('button', { name: '從 Jira 匯入' }));
    fireEvent.change(screen.getByLabelText('Jira 票號'), { target: { value: 'NOPE-1' } });
    fireEvent.click(screen.getByRole('button', { name: '匯入' }));
    expect((await screen.findByRole('alert')).textContent).toBe('找不到票 NOPE-1');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('StartQuestDialog', () => {
  const open = quest({ id: 'q', status: 'open', title: '修 bug' });
  const seed = () =>
    useGame.setState({
      npcs: {
        clerk: npc({ id: 'clerk', name: '公會櫃檯', builtin: 'clerk' }),
        busy: npc({ id: 'busy', name: '忙碌的人', busyQuestId: 'other' }),
        a: npc({ id: 'a', name: '亞瑟' }),
        b: npc({ id: 'b', name: '蓓兒', homeDungeonId: 'd2' }),
      },
      dungeons: { d1: dungeon('d1', 'alpha'), d2: dungeon('d2', 'beta') },
    });

  it('excludes the clerk and busy NPCs from the NPC menu', () => {
    seed();
    render(<StartQuestDialog quest={open} onClose={() => undefined} />);
    const options = within(screen.getByLabelText('冒險者')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['亞瑟', '蓓兒']);
  });

  it("defaults the dungeon to the chosen NPC's home dungeon and posts the start request", async () => {
    seed();
    const started = quest({ id: 'q', status: 'adventuring', npcId: 'b', dungeonId: 'd2' });
    const fetchFn = mockFetch(() => ({ body: started }));
    const onClose = vi.fn();
    render(<StartQuestDialog quest={open} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('冒險者'), { target: { value: 'b' } });
    expect((screen.getByLabelText('地下城') as HTMLSelectElement).value).toBe('d2');
    fireEvent.click(screen.getByRole('button', { name: '出發' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/quests/q/start');
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({ npcId: 'b', dungeonId: 'd2' });
    expect(useGame.getState().quests['q']?.status).toBe('adventuring');
  });

  it('shows the server error and keeps the dialog open', async () => {
    seed();
    mockFetch(() => ({ status: 409, body: { error: '這位冒險者正在忙' } }));
    const onClose = vi.fn();
    render(<StartQuestDialog quest={open} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '出發' }));
    expect((await screen.findByRole('alert')).textContent).toBe('這位冒險者正在忙');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clicking 派遣 on an open card opens the dialog', () => {
    seed();
    useGame.setState({ quests: { q: open } });
    render(<Board />);
    act(() => screen.getByRole('button', { name: '派遣' }).click());
    expect(screen.getByRole('dialog', { name: /派遣冒險者/ })).toBeTruthy();
  });
});
