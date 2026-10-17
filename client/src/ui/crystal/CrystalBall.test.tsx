import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Approval, GameEvent, Npc, Quest, SessionListItem, TranscriptMessage } from '@loc/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState, useGame } from '../../state/store';
import { CrystalBall } from './CrystalBall';

const npc: Npc = {
  id: 'n1', name: '亞瑟', classId: 'warrior', persona: '', model: 'm', effort: 'high',
  equipment: { connectorPrefixes: [], readOnly: false }, skills: [],
};
const clerk: Npc = { ...npc, id: 'clerk', name: '公會櫃檯', builtin: 'clerk' };
const questSession: SessionListItem = { id: 's-quest', npcId: 'n1', questId: 'q1', title: '修登入', cwd: '/x', updatedAt: 2000, live: true };
const chatSession: SessionListItem = { id: 's-chat', npcId: 'n1', title: '閒聊一下', cwd: '/x', updatedAt: 1000, live: false };
const quest = (status: Quest['status']): Quest => ({
  id: 'q1', title: '修登入', body: '', stars: 2, status, source: { kind: 'local' }, npcId: 'n1', sessionId: 's-quest',
  rejections: 0, createdAt: 1, updatedAt: 1,
});
const approval: Approval = { id: 'a1', npcId: 'n1', sessionId: 's-quest', questId: 'q1', toolName: 'Bash', summary: '執行 rm -rf build', reason: '清理輸出', createdAt: 5 };

let history: Record<string, TranscriptMessage[]>;
let sessions: SessionListItem[];

function mockFetch(extra?: (path: string, init: RequestInit) => { status?: number; body?: unknown } | undefined) {
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace(/^\/api/, '');
    const custom = extra?.(path, init);
    const { status = 200, body } =
      custom ??
      (path === '/sessions'
        ? { body: sessions }
        : path.startsWith('/sessions/')
          ? { body: history[decodeURIComponent(path.split('/')[2]!)] ?? [] }
          : { body: {} });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function ev(partial: Partial<GameEvent> & Pick<GameEvent, 'kind' | 'label'>): GameEvent {
  return { id: `e${Math.random()}`, sessionId: 's-quest', npcId: 'n1', at: Date.now() + 60_000, ...partial };
}

beforeEach(() => {
  sessionStorage.setItem('loc.token', 'test-token');
  useGame.setState({ ...initialState(), npcs: { n1: npc, clerk } });
  history = {};
  sessions = [chatSession, questSession];
});
afterEach(() => {
  cleanup();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('CrystalBall', () => {
  it('lists sessions grouped by NPC with live ones first and marked 冒險中', async () => {
    mockFetch();
    render(<CrystalBall />);
    const group = await screen.findByRole('region', { name: '亞瑟' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons[0]!.textContent).toContain('冒險中');
    expect(buttons[0]!.textContent).toContain('修登入');
    expect(buttons[1]!.textContent).toContain('閒聊一下');
  });

  it('shows the pigeon letter for the selected session and posts {allow:true} on 同意', async () => {
    useGame.setState({ quests: { q1: quest('adventuring') }, approvals: { a1: approval }, ui: { panel: 'crystal', crystalSessionId: 's-quest' } });
    const fetchFn = mockFetch();
    render(<CrystalBall />);
    const letter = await screen.findByRole('article', { name: /信鴿來信/ });
    expect(within(letter).getByText('執行 rm -rf build')).toBeTruthy();
    expect(within(letter).getByText('理由：清理輸出')).toBeTruthy();
    fireEvent.click(within(letter).getByRole('button', { name: '同意' }));
    await waitFor(() => expect(useGame.getState().approvals['a1']).toBeUndefined());
    const post = fetchFn.mock.calls.find(([u]) => u === '/api/approvals/a1')!;
    expect(post[1]?.method).toBe('POST');
    expect(JSON.parse(String(post[1]?.body))).toEqual({ allow: true });
  });

  it('sends 拒絕 with the optional reason', async () => {
    useGame.setState({ quests: { q1: quest('adventuring') }, approvals: { a1: approval }, ui: { panel: 'crystal', crystalSessionId: 's-quest' } });
    const fetchFn = mockFetch();
    render(<CrystalBall />);
    const letter = await screen.findByRole('article', { name: /信鴿來信/ });
    fireEvent.change(within(letter).getByLabelText('拒絕理由（選填）'), { target: { value: '太危險' } });
    fireEvent.click(within(letter).getByRole('button', { name: '拒絕' }));
    await waitFor(() => expect(useGame.getState().approvals['a1']).toBeUndefined());
    const post = fetchFn.mock.calls.find(([u]) => u === '/api/approvals/a1')!;
    expect(JSON.parse(String(post[1]?.body))).toEqual({ allow: false, message: '太危險' });
  });

  it('mailbox lists approvals across sessions and clicking one selects that session', async () => {
    const other: Approval = { ...approval, id: 'a2', sessionId: 's-chat', summary: '改寫設定檔', createdAt: 6 };
    useGame.setState({ quests: { q1: quest('adventuring') }, approvals: { a1: approval, a2: other }, ui: { panel: 'crystal' } });
    mockFetch();
    render(<CrystalBall />);
    const mailbox = await screen.findByRole('region', { name: '信箱' });
    expect(within(mailbox).getByText('執行 rm -rf build')).toBeTruthy();
    fireEvent.click(within(mailbox).getByText('改寫設定檔'));
    expect(useGame.getState().ui.crystalSessionId).toBe('s-chat');
    expect(await screen.findByRole('heading', { name: '閒聊一下' })).toBeTruthy();
    expect(await screen.findByRole('article', { name: /信鴿來信/ })).toBeTruthy();
  });

  it('quest session shows 傳信 and 召回; 傳信 posts the message and 召回 confirms first', async () => {
    useGame.setState({ quests: { q1: quest('adventuring') }, ui: { panel: 'crystal', crystalSessionId: 's-quest' } });
    const fetchFn = mockFetch();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<CrystalBall />);
    fireEvent.change(await screen.findByLabelText('傳信內容'), { target: { value: '記得跑測試' } });
    fireEvent.click(screen.getByRole('button', { name: '傳信' }));
    await waitFor(() => expect(fetchFn.mock.calls.some(([u]) => u === '/api/quests/q1/message')).toBe(true));
    const msg = fetchFn.mock.calls.find(([u]) => u === '/api/quests/q1/message')!;
    expect(JSON.parse(String(msg[1]?.body))).toEqual({ text: '記得跑測試' });

    fireEvent.click(screen.getByRole('button', { name: '召回' }));
    expect(fetchFn.mock.calls.some(([u]) => u === '/api/quests/q1/recall')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '召回' }));
    await waitFor(() => expect(fetchFn.mock.calls.some(([u]) => u === '/api/quests/q1/recall')).toBe(true));
    expect(confirmSpy).toHaveBeenCalledTimes(2);
  });

  it('chat session has no 召回 and sends through /api/chats with the session id', async () => {
    useGame.setState({ ui: { panel: 'crystal', crystalSessionId: 's-chat' } });
    const fetchFn = mockFetch((path, init) => (path === '/chats' && init.method === 'POST' ? { body: { sessionId: 's-chat' } } : undefined));
    render(<CrystalBall />);
    fireEvent.change(await screen.findByLabelText('聊天內容'), { target: { value: '你好' } });
    expect(screen.queryByRole('button', { name: '召回' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(fetchFn.mock.calls.some(([u]) => u === '/api/chats')).toBe(true));
    const post = fetchFn.mock.calls.find(([u]) => u === '/api/chats')!;
    expect(JSON.parse(String(post[1]?.body))).toEqual({ npcId: 'n1', text: '你好', sessionId: 's-chat' });
  });

  it('a finished quest session is read-only', async () => {
    useGame.setState({ quests: { q1: quest('review') }, ui: { panel: 'crystal', crystalSessionId: 's-quest' } });
    mockFetch();
    render(<CrystalBall />);
    expect(await screen.findByText('這趟冒險已經結束，日誌只能閱讀。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '傳信' })).toBeNull();
    expect(screen.queryByRole('button', { name: '召回' })).toBeNull();
  });

  it('starts a chat with an NPC (clerk excluded), then selects the created session; a busy NPC shows the server message', async () => {
    let busy = true;
    const fetchFn = mockFetch((path, init) => {
      if (path === '/chats' && init.method === 'POST') {
        return busy ? { status: 409, body: { error: '亞瑟正在冒險，請改用傳信' } } : { body: { sessionId: 's-chat' } };
      }
      return undefined;
    });
    render(<CrystalBall />);
    fireEvent.click(await screen.findByRole('button', { name: '與 NPC 聊天' }));
    const select = screen.getByLabelText('選擇聊天對象') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['選擇 NPC', '亞瑟']);
    fireEvent.change(select, { target: { value: 'n1' } });
    fireEvent.change(await screen.findByLabelText('聊天內容'), { target: { value: '嗨' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    expect((await screen.findByRole('alert')).textContent).toContain('請改用傳信');
    busy = false;
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(useGame.getState().ui.crystalSessionId).toBe('s-chat'));
    const post = fetchFn.mock.calls.filter(([u]) => u === '/api/chats').at(-1)!;
    expect(JSON.parse(String(post[1]?.body))).toEqual({ npcId: 'n1', text: '嗨' });
  });

  it('expands a live tool_start event to show its detail, and labels 使魔 / 營火 / compact', async () => {
    useGame.setState({
      quests: { q1: quest('adventuring') },
      ui: { panel: 'crystal', crystalSessionId: 's-quest' },
      events: {
        's-quest': [
          ev({ kind: 'tool_start', label: 'npm test', detail: 'Bash', toolUseId: 't1' }),
          ev({ kind: 'tool_end', label: 'npm test', detail: '全部通過', toolUseId: 't1' }),
          ev({ kind: 'compact', label: '整理' }),
          ev({ kind: 'subagent_start', label: '查資料', detail: 'Task', toolUseId: 't2' }),
          ev({ kind: 'background_start', label: '跑伺服器', detail: 'Bash', toolUseId: 't3' }),
        ],
      },
    });
    mockFetch();
    render(<CrystalBall />);
    const row = (await screen.findByRole('button', { name: /npm test/ }));
    expect(screen.queryByText('全部通過')).toBeNull();
    fireEvent.click(row);
    expect(screen.getByText('工具：Bash')).toBeTruthy();
    expect(screen.getByText('全部通過')).toBeTruthy();
    expect(screen.getByText('正在整理筆記')).toBeTruthy();
    expect(screen.getByRole('button', { name: /使魔.*查資料/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /營火.*跑伺服器/ })).toBeTruthy();
  });

  it('does not duplicate live events that predate the history fetch, and refetches history on result', async () => {
    history['s-quest'] = [{ role: 'assistant', blocks: [{ type: 'text', text: '歷史內容' }] }];
    const old = ev({ kind: 'text', label: '舊事件', detail: '舊事件', at: 1 });
    useGame.setState({ quests: { q1: quest('adventuring') }, ui: { panel: 'crystal', crystalSessionId: 's-quest' }, events: { 's-quest': [old] } });
    const fetchFn = mockFetch();
    render(<CrystalBall />);
    expect(await screen.findByText('歷史內容')).toBeTruthy();
    expect(screen.queryByText('舊事件')).toBeNull();
    const historyCalls = () => fetchFn.mock.calls.filter(([u]) => u === '/api/sessions/s-quest/messages').length;
    expect(historyCalls()).toBe(1);
    history['s-quest'] = [{ role: 'assistant', blocks: [{ type: 'text', text: '更新後的歷史' }] }];
    useGame.getState().applyServerMessage({ type: 'event', event: ev({ kind: 'result', label: '冒險回報', detail: 'ok', at: 2 }) });
    expect(await screen.findByText('更新後的歷史')).toBeTruthy();
    expect(historyCalls()).toBe(2);
  });

  it('renders history tool calls with Edit input as a colored diff and pairs the tool result', async () => {
    history['s-quest'] = [
      { role: 'user', blocks: [{ type: 'text', text: '請修改' }] },
      { role: 'assistant', blocks: [{ type: 'tool_use', id: 'u1', name: 'Edit', summary: 'a.ts', input: { file_path: 'a.ts', old_string: 'foo\nbar', new_string: 'baz' } }] },
      { role: 'user', blocks: [{ type: 'tool_result', toolUseId: 'u1', isError: false, output: '已編輯' }] },
    ];
    useGame.setState({ quests: { q1: quest('adventuring') }, ui: { panel: 'crystal', crystalSessionId: 's-quest' } });
    mockFetch();
    render(<CrystalBall />);
    fireEvent.click(await screen.findByRole('button', { name: /Edit.*a\.ts/ }));
    const del = screen.getByText('- foo');
    expect(del.className).toContain('diff-del');
    expect(screen.getByText('- bar').className).toContain('diff-del');
    expect(screen.getByText('+ baz').className).toContain('diff-add');
    expect(screen.getByText('已編輯')).toBeTruthy();
  });

  it('renders adventurer markdown (history, live text, result) as styled HTML, but keeps 會長 text raw', async () => {
    history['s-quest'] = [
      { role: 'user', blocks: [{ type: 'text', text: '請用 **粗體** 回覆' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: '## 計畫\n\n- 第一步 **重現**\n- 第二步 `npm test`\n\n| 欄 | 值 |\n|---|---|\n| a | 1 |' }] },
    ];
    useGame.setState({
      quests: { q1: quest('adventuring') },
      ui: { panel: 'crystal', crystalSessionId: 's-quest' },
      events: {
        's-quest': [
          ev({ kind: 'text', label: 'x', detail: '看 [文件](https://example.com) 與 *斜體*\n\n```ts\nconst a = 1;\n```' }),
          ev({ kind: 'result', label: '冒險回報', detail: '# 卷軸\n\n1. 修好了' }),
        ],
      },
    });
    mockFetch();
    render(<CrystalBall />);
    const log = await screen.findByLabelText('冒險日誌');
    expect((await within(log).findByRole('heading', { name: '計畫' })).tagName).toBe('H2');
    expect(within(log).getByText('重現').tagName).toBe('STRONG');
    expect(within(log).getByText('npm test').tagName).toBe('CODE');
    expect(within(log).getByRole('table')).toBeTruthy();
    const link = within(log).getByRole('link', { name: '文件' });
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(within(log).getByText('斜體').tagName).toBe('EM');
    expect(within(log).getByText('const a = 1;').closest('pre')).toBeTruthy();
    expect(within(log).getByRole('heading', { name: '卷軸' }).tagName).toBe('H1');
    expect(within(log).getByText('修好了').tagName).toBe('LI');
    expect(within(log).getByText(/請用 \*\*粗體\*\* 回覆/)).toBeTruthy();
    expect(within(log).queryByText('**')).toBeNull();
  });

  it('does not render raw HTML or javascript: links from adventurer markdown', async () => {
    history['s-quest'] = [
      { role: 'assistant', blocks: [{ type: 'text', text: '<img src=x onerror="alert(1)"><b>粗</b> [點我](javascript:alert(1))' }] },
    ];
    useGame.setState({ quests: { q1: quest('adventuring') }, ui: { panel: 'crystal', crystalSessionId: 's-quest' } });
    mockFetch();
    render(<CrystalBall />);
    const log = await screen.findByLabelText('冒險日誌');
    await within(log).findByText(/點我/);
    expect(log.querySelector('img')).toBeNull();
    expect(log.querySelector('b')).toBeNull();
    expect(log.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('refreshes the session list when an event for an unknown session arrives', async () => {
    const fetchFn = mockFetch();
    render(<CrystalBall />);
    await screen.findByRole('region', { name: '亞瑟' });
    const listCalls = () => fetchFn.mock.calls.filter(([u]) => u === '/api/sessions').length;
    expect(listCalls()).toBe(1);
    sessions = [{ ...chatSession, id: 's-new', title: '新的一段' }, ...sessions];
    useGame.getState().applyServerMessage({ type: 'event', event: ev({ kind: 'text', label: 'hi', sessionId: 's-new' }) });
    expect(await screen.findByText('新的一段')).toBeTruthy();
    expect(listCalls()).toBe(2);
  });

  it('only the current session of a quest gets 傳信/召回; an older session is read-only', async () => {
    const oldSession: SessionListItem = { ...questSession, id: 's-old', updatedAt: 500, live: false };
    sessions = [questSession, oldSession];
    useGame.setState({ quests: { q1: quest('adventuring') }, ui: { panel: 'crystal', crystalSessionId: 's-old' } });
    mockFetch();
    render(<CrystalBall />);
    expect(await screen.findByText('這是先前冒險的紀錄')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '傳信' })).toBeNull();
    expect(screen.queryByRole('button', { name: '召回' })).toBeNull();
    act(() => useGame.getState().openCrystal('s-quest'));
    expect(await screen.findByRole('button', { name: '傳信' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '召回' })).toBeTruthy();
    expect(screen.queryByText('這是先前冒險的紀錄')).toBeNull();
  });

  it('a late history response for the previous session does not affect the new selection', async () => {
    let resolveA: (r: Response) => void = () => {};
    const aPromise = new Promise<Response>((r) => (resolveA = r));
    history['s-quest'] = [{ role: 'assistant', blocks: [{ type: 'text', text: '委託的內容' }] }];
    history['s-chat'] = [{ role: 'assistant', blocks: [{ type: 'text', text: '閒聊的內容' }] }];
    const inner = mockFetch();
    const base = (inner.getMockImplementation() as (u: string, i?: RequestInit) => Promise<Response>);
    vi.stubGlobal('fetch', vi.fn((u: string, i?: RequestInit) => (u === '/api/sessions/s-chat/messages' ? aPromise : base(u, i))));
    useGame.setState({ ui: { panel: 'crystal', crystalSessionId: 's-chat' } });
    render(<CrystalBall />);
    await screen.findByRole('region', { name: '亞瑟' });
    act(() => useGame.getState().openCrystal('s-quest'));
    expect(await screen.findByText('委託的內容')).toBeTruthy();
    resolveA(new Response(JSON.stringify(history['s-chat']), { status: 200 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('閒聊的內容')).toBeNull();
    expect(screen.getByText('委託的內容')).toBeTruthy();
  });

  it('a double-click on 同意 posts exactly once', async () => {
    useGame.setState({ quests: { q1: quest('adventuring') }, approvals: { a1: approval }, ui: { panel: 'crystal', crystalSessionId: 's-quest' } });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const inner = mockFetch();
    const base = (inner.getMockImplementation() as (u: string, i?: RequestInit) => Promise<Response>);
    const fn = vi.fn(async (u: string, i?: RequestInit) => {
      if (u === '/api/approvals/a1') {
        await gate;
        return new Response('{}', { status: 200 });
      }
      return base(u, i);
    });
    vi.stubGlobal('fetch', fn);
    render(<CrystalBall />);
    const btn = await screen.findByRole('button', { name: '同意' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    release();
    await waitFor(() => expect(useGame.getState().approvals['a1']).toBeUndefined());
    expect(fn.mock.calls.filter(([u]) => u === '/api/approvals/a1')).toHaveLength(1);
  });

  it('a late new-chat reply does not override a newer selection', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const inner = mockFetch();
    const base = (inner.getMockImplementation() as (u: string, i?: RequestInit) => Promise<Response>);
    vi.stubGlobal('fetch', vi.fn(async (u: string, i?: RequestInit) => {
      if (u === '/api/chats') {
        await gate;
        return new Response(JSON.stringify({ sessionId: 's-created' }), { status: 200 });
      }
      return base(u, i);
    }));
    render(<CrystalBall />);
    fireEvent.click(await screen.findByRole('button', { name: '與 NPC 聊天' }));
    fireEvent.change(screen.getByLabelText('選擇聊天對象'), { target: { value: 'n1' } });
    fireEvent.change(await screen.findByLabelText('聊天內容'), { target: { value: '嗨' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    fireEvent.click(await screen.findByText('閒聊一下'));
    expect(useGame.getState().ui.crystalSessionId).toBe('s-chat');
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(useGame.getState().ui.crystalSessionId).toBe('s-chat');
  });

  it('does not auto-scroll when the reader has scrolled up, but follows when near the bottom', async () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    useGame.setState({ quests: { q1: quest('adventuring') }, ui: { panel: 'crystal', crystalSessionId: 's-quest' } });
    mockFetch();
    render(<CrystalBall />);
    const box = await screen.findByLabelText('冒險日誌');
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const geometry = (top: number) => {
      Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 1000 });
      Object.defineProperty(box, 'clientHeight', { configurable: true, value: 200 });
      Object.defineProperty(box, 'scrollTop', { configurable: true, value: top });
      fireEvent.scroll(box);
    };
    geometry(100); // far from the bottom
    spy.mockClear();
    act(() => useGame.getState().applyServerMessage({ type: 'event', event: ev({ kind: 'text', label: 'a', detail: 'a' }) }));
    await screen.findByText('a');
    expect(spy).not.toHaveBeenCalled();
    geometry(790); // within 40px of the bottom
    act(() => useGame.getState().applyServerMessage({ type: 'event', event: ev({ kind: 'text', label: 'b', detail: 'b' }) }));
    await screen.findByText('b');
    expect(spy).toHaveBeenCalled();
  });
});
