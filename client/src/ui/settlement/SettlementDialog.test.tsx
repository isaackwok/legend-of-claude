import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Quest, SettlementRecord } from '@loc/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState, useGame } from '../../state/store';
import { RejectDialog } from '../board/RejectDialog';
import { SettlementDialog } from './SettlementDialog';

const quest = (over: Partial<Quest> & Pick<Quest, 'id'>): Quest => ({
  title: `標題 ${over.id}`, body: '', stars: 2, status: 'review', source: { kind: 'local' }, rejections: 0, createdAt: 1, updatedAt: 1, ...over,
});
const jiraQuest = (over: Partial<Quest> = {}) =>
  quest({ id: 'j', source: { kind: 'jira', key: 'LOC-7', url: 'https://example.atlassian.net/browse/LOC-7' }, scroll: '卷軸內容', ...over });

type Reply = { status?: number; body?: unknown };
function mockFetch(handler: (path: string, init: RequestInit) => Reply | Promise<Reply>) {
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const { status = 200, body } = await handler(String(url).replace(/^\/api/, ''), init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const posts = (fn: ReturnType<typeof mockFetch>, suffix: string) =>
  fn.mock.calls.filter(([url, init]) => String(url).endsWith(suffix) && (init as RequestInit | undefined)?.method === 'POST');
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as unknown;

const OPTIONS_JIRA = { isJira: true, transitions: [{ id: '11', name: '進行中' }, { id: '31', name: '完成' }] };
const record = (over: Partial<SettlementRecord> = {}): SettlementRecord => ({
  choices: { pushAndPr: true, linkPr: false, openTicket: false },
  prUrl: 'https://github.com/o/r/pull/1',
  results: [{ action: '推上分支並開 PR', ok: true, message: '已開 PR' }, { action: '改 Jira 狀態', ok: false, message: '狀態轉換失敗' }],
  at: 5,
  ...over,
});

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

function open(q: Quest) {
  useGame.setState({ quests: { [q.id]: q }, ui: { panel: 'board', settlementQuestId: q.id } });
  return render(<SettlementDialog questId={q.id} />);
}

describe('SettlementDialog', () => {
  it('shows only 推上分支並開 PR for a local quest', async () => {
    mockFetch(() => ({ body: { isJira: false, transitions: [] } }));
    open(quest({ id: 'l' }));
    expect(await screen.findByLabelText('推上分支並開 PR')).toBeTruthy();
    expect(screen.queryByLabelText('把 Jira 狀態改為')).toBeNull();
    expect(screen.queryByLabelText('在 Jira 留言')).toBeNull();
    expect(screen.queryByLabelText('在 Jira 貼上 PR 連結')).toBeNull();
    expect(screen.queryByLabelText('在瀏覽器打開這張 Jira 票')).toBeNull();
  });

  it('disables 貼上 PR 連結 until 開 PR is checked (Jira quest)', async () => {
    mockFetch(() => ({ body: OPTIONS_JIRA }));
    open(jiraQuest());
    const push = (await screen.findByLabelText('推上分支並開 PR')) as HTMLInputElement;
    const link = screen.getByLabelText('在 Jira 貼上 PR 連結') as HTMLInputElement;
    // Default with no lastChoices: pushAndPr on, everything else off.
    expect(push.checked).toBe(true);
    expect(link.disabled).toBe(false);
    fireEvent.click(link);
    expect(link.checked).toBe(true);
    fireEvent.click(push);
    expect(link.disabled).toBe(true);
    expect(link.checked).toBe(false);
  });

  it('prefills from lastChoices', async () => {
    mockFetch(() => ({
      body: { ...OPTIONS_JIRA, lastChoices: { pushAndPr: false, jiraTransitionId: '31', jiraComment: '舊留言', linkPr: false, openTicket: true } },
    }));
    open(jiraQuest());
    const push = (await screen.findByLabelText('推上分支並開 PR')) as HTMLInputElement;
    expect(push.checked).toBe(false);
    expect((screen.getByLabelText('把 Jira 狀態改為') as HTMLSelectElement).value).toBe('31');
    expect((screen.getByLabelText('在 Jira 留言') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('在瀏覽器打開這張 Jira 票') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('在 Jira 貼上 PR 連結') as HTMLInputElement).disabled).toBe(true);
  });

  it('ignores lastChoices for actions that do not apply to a local quest', async () => {
    const fn = mockFetch((path) =>
      path.endsWith('/settle')
        ? { body: record() }
        : { body: { isJira: false, transitions: [], lastChoices: { pushAndPr: true, jiraTransitionId: '31', jiraComment: 'x', linkPr: true, openTicket: true } } },
    );
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    useGame.setState({ quests: { l: quest({ id: 'l' }) }, ui: { panel: 'board', settlementQuestId: 'l' } });
    render(<SettlementDialog questId="l" />);
    fireEvent.click(await screen.findByRole('button', { name: '結算' }));
    await screen.findByRole('button', { name: '關閉' });
    expect(bodyOf(posts(fn, '/settle')[0]!)).toEqual({ pushAndPr: true, linkPr: false, openTicket: false });
    expect(open).not.toHaveBeenCalled();
  });

  it('defaults the comment to the quest scroll and sends the checked choices', async () => {
    const fn = mockFetch((path) => (path.endsWith('/settle') ? { body: record() } : { body: OPTIONS_JIRA }));
    open(jiraQuest());
    await screen.findByLabelText('推上分支並開 PR');
    fireEvent.change(screen.getByLabelText('把 Jira 狀態改為'), { target: { value: '11' } });
    fireEvent.click(screen.getByLabelText('在 Jira 留言'));
    const box = screen.getByLabelText('留言內容') as HTMLTextAreaElement;
    expect(box.value).toBe('卷軸內容');
    fireEvent.change(box, { target: { value: '改過的留言' } });
    fireEvent.click(screen.getByLabelText('在 Jira 貼上 PR 連結'));
    fireEvent.click(screen.getByRole('button', { name: '結算' }));
    await screen.findByRole('button', { name: '關閉' });
    expect(posts(fn, '/settle')).toHaveLength(1);
    expect(bodyOf(posts(fn, '/settle')[0]!)).toEqual({
      pushAndPr: true, jiraTransitionId: '11', jiraComment: '改過的留言', linkPr: true, openTicket: false,
    });
  });

  it('omits the transition for 不變更 and the comment when unchecked', async () => {
    const fn = mockFetch((path) => (path.endsWith('/settle') ? { body: record() } : { body: OPTIONS_JIRA }));
    open(jiraQuest());
    await screen.findByLabelText('推上分支並開 PR');
    fireEvent.click(screen.getByRole('button', { name: '結算' }));
    await screen.findByRole('button', { name: '關閉' });
    expect(bodyOf(posts(fn, '/settle')[0]!)).toEqual({ pushAndPr: true, linkPr: false, openTicket: false });
  });

  it('opens the Jira ticket after a successful settle when 打開這張票 is checked', async () => {
    mockFetch((path) => (path.endsWith('/settle') ? { body: record() } : { body: OPTIONS_JIRA }));
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    open(jiraQuest());
    await screen.findByLabelText('推上分支並開 PR');
    fireEvent.click(screen.getByLabelText('在瀏覽器打開這張 Jira 票'));
    fireEvent.click(screen.getByRole('button', { name: '結算' }));
    await screen.findByRole('button', { name: '關閉' });
    expect(openSpy).toHaveBeenCalledWith('https://example.atlassian.net/browse/LOC-7', '_blank', 'noopener');
  });

  it('also renders an 開啟 Jira 票 link on the results screen when the ticket was chosen', async () => {
    mockFetch((path) => (path.endsWith('/settle') ? { body: record({ prUrl: undefined }) } : { body: OPTIONS_JIRA }));
    vi.spyOn(window, 'open').mockReturnValue(null);
    open(jiraQuest());
    await screen.findByLabelText('推上分支並開 PR');
    fireEvent.click(screen.getByLabelText('在瀏覽器打開這張 Jira 票'));
    fireEvent.click(screen.getByRole('button', { name: '結算' }));
    await screen.findByRole('button', { name: '關閉' });
    const link = screen.getByRole('link', { name: '開啟 Jira 票' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://example.atlassian.net/browse/LOC-7');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('shows no ticket link when the ticket was not chosen', async () => {
    mockFetch((path) => (path.endsWith('/settle') ? { body: record({ prUrl: undefined }) } : { body: OPTIONS_JIRA }));
    open(jiraQuest());
    await screen.findByLabelText('推上分支並開 PR');
    fireEvent.click(screen.getByRole('button', { name: '結算' }));
    await screen.findByRole('button', { name: '關閉' });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('rejects non-http URLs: no window.open, no ticket link, no PR anchor', async () => {
    mockFetch((path) => (path.endsWith('/settle') ? { body: record({ prUrl: 'javascript:alert(2)' }) } : { body: OPTIONS_JIRA }));
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    open(jiraQuest({ source: { kind: 'jira', key: 'LOC-7', url: 'javascript:alert(1)' } }));
    await screen.findByLabelText('推上分支並開 PR');
    fireEvent.click(screen.getByLabelText('在瀏覽器打開這張 Jira 票'));
    fireEvent.click(screen.getByRole('button', { name: '結算' }));
    await screen.findByRole('button', { name: '關閉' });
    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says the quest stays in review when the push failed, with the branch and worktree path (R35)', async () => {
    const failed = record({
      prUrl: undefined,
      accepted: false,
      branch: 'loc/LOC-7-abcdef',
      worktreePath: '/data/worktrees/loc-LOC-7-abcdef',
      results: [{ action: 'pushAndPr', ok: false, message: '推送分支失敗：Permission denied' }],
    });
    mockFetch((path) => (path.endsWith('/settle') ? { body: failed } : { body: OPTIONS_JIRA }));
    open(jiraQuest());
    await screen.findByLabelText('推上分支並開 PR');
    fireEvent.click(screen.getByRole('button', { name: '結算' }));
    await screen.findByRole('button', { name: '關閉' });
    expect(screen.getByText('委託仍在待驗收，可修正後重新結算')).toBeTruthy();
    expect(screen.getByText('loc/LOC-7-abcdef')).toBeTruthy();
    expect(screen.getByText('/data/worktrees/loc-LOC-7-abcdef')).toBeTruthy();
    expect(screen.getByText(/推送分支失敗：Permission denied/)).toBeTruthy();
  });

  it('shows the branch and worktree path but no stays-in-review note after an accepted settle', async () => {
    mockFetch((path) => (path.endsWith('/settle') ? { body: record({ accepted: true, branch: 'loc/q', worktreePath: '/w/loc-q' }) } : { body: OPTIONS_JIRA }));
    open(jiraQuest());
    await screen.findByLabelText('推上分支並開 PR');
    fireEvent.click(screen.getByRole('button', { name: '結算' }));
    await screen.findByRole('button', { name: '關閉' });
    expect(screen.getByText('loc/q')).toBeTruthy();
    expect(screen.getByText('/w/loc-q')).toBeTruthy();
    expect(screen.queryByText('委託仍在待驗收，可修正後重新結算')).toBeNull();
  });

  it('disables 結算 and explains when the quest is no longer in review', async () => {
    mockFetch(() => ({ body: OPTIONS_JIRA }));
    open(jiraQuest());
    await screen.findByLabelText('推上分支並開 PR');
    expect((screen.getByRole('button', { name: '結算' }) as HTMLButtonElement).disabled).toBe(false);
    act(() => useGame.setState({ quests: { j: jiraQuest({ status: 'done' }) } }));
    expect(screen.getByText('這個委託已結算或不在待驗收狀態')).toBeTruthy();
    expect((screen.getByRole('button', { name: '結算' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the results visible when the quest turns done while settling', async () => {
    let release: (r: Reply) => void = () => undefined;
    const pending = new Promise<Reply>((resolve) => (release = resolve));
    mockFetch((path) => (path.endsWith('/settle') ? pending : { body: OPTIONS_JIRA }));
    open(jiraQuest());
    await screen.findByLabelText('推上分支並開 PR');
    fireEvent.click(screen.getByRole('button', { name: '結算' }));
    await screen.findByText('公會櫃檯正在結算…');
    act(() => useGame.setState({ quests: { j: jiraQuest({ status: 'done' }) } }));
    expect(screen.queryByText('這個委託已結算或不在待驗收狀態')).toBeNull();
    release({ body: record() });
    await screen.findByRole('button', { name: '關閉' });
  });

  it('hints and disables 結算 when the comment is checked but blank', async () => {
    mockFetch(() => ({ body: OPTIONS_JIRA }));
    open(jiraQuest({ scroll: '' }));
    await screen.findByLabelText('推上分支並開 PR');
    fireEvent.click(screen.getByLabelText('在 Jira 留言'));
    expect(screen.getByText('留言內容不可空白')).toBeTruthy();
    expect((screen.getByRole('button', { name: '結算' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('留言內容'), { target: { value: '內容' } });
    expect(screen.queryByText('留言內容不可空白')).toBeNull();
    expect((screen.getByRole('button', { name: '結算' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('treats lastChoices: null like no lastChoices', async () => {
    mockFetch(() => ({ body: { ...OPTIONS_JIRA, lastChoices: null } }));
    open(jiraQuest());
    expect(((await screen.findByLabelText('推上分支並開 PR')) as HTMLInputElement).checked).toBe(true);
  });

  it('does not open the ticket when the settle request fails', async () => {
    mockFetch((path) => (path.endsWith('/settle') ? { status: 409, body: { error: '已在結算中' } } : { body: OPTIONS_JIRA }));
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    open(jiraQuest());
    await screen.findByLabelText('推上分支並開 PR');
    fireEvent.click(screen.getByLabelText('在瀏覽器打開這張 Jira 票'));
    fireEvent.click(screen.getByRole('button', { name: '結算' }));
    expect((await screen.findByRole('alert')).textContent).toContain('已在結算中');
    expect(openSpy).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '結算' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows progress while settling, ignores Escape, then lists each result and the PR link', async () => {
    let release: (r: Reply) => void = () => undefined;
    const pending = new Promise<Reply>((resolve) => (release = resolve));
    mockFetch((path) => (path.endsWith('/settle') ? pending : { body: OPTIONS_JIRA }));
    open(jiraQuest());
    await screen.findByLabelText('推上分支並開 PR');
    fireEvent.click(screen.getByRole('button', { name: '結算' }));
    expect(await screen.findByText('公會櫃檯正在結算…')).toBeTruthy();
    for (const el of screen.getAllByRole('button')) expect((el as HTMLButtonElement).disabled).toBe(true);
    for (const el of screen.getAllByRole('checkbox')) expect((el as HTMLInputElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useGame.getState().ui.settlementQuestId).toBe('j');
    expect(screen.getByRole('dialog')).toBeTruthy();

    release({ body: record() });
    await screen.findByRole('button', { name: '關閉' });
    expect(screen.getByText(/已開 PR/)).toBeTruthy();
    expect(screen.getByText(/狀態轉換失敗/)).toBeTruthy();
    expect(screen.getByText('成功')).toBeTruthy();
    expect(screen.getByText('失敗')).toBeTruthy();
    const link = screen.getByRole('link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://github.com/o/r/pull/1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');

    fireEvent.click(screen.getByRole('button', { name: '關閉' }));
    expect(useGame.getState().ui.settlementQuestId).toBeUndefined();
  });

  it('sends one POST on a double click of 結算', async () => {
    const fn = mockFetch((path) => (path.endsWith('/settle') ? { body: record() } : { body: OPTIONS_JIRA }));
    open(jiraQuest());
    await screen.findByLabelText('推上分支並開 PR');
    const btn = screen.getByRole('button', { name: '結算' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await screen.findByRole('button', { name: '關閉' });
    expect(posts(fn, '/settle')).toHaveLength(1);
  });

  it('shows the options error on 502 but still lets you settle with pushAndPr', async () => {
    const fn = mockFetch((path) => (path.endsWith('/settle') ? { body: record() } : { status: 502, body: { error: '公會櫃檯無法列出 Jira 狀態' } }));
    open(jiraQuest());
    expect((await screen.findByRole('alert')).textContent).toContain('公會櫃檯無法列出 Jira 狀態');
    const push = screen.getByLabelText('推上分支並開 PR') as HTMLInputElement;
    expect(push.checked).toBe(true);
    expect(screen.queryByLabelText('把 Jira 狀態改為')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '結算' }));
    await screen.findByRole('button', { name: '關閉' });
    expect(bodyOf(posts(fn, '/settle')[0]!)).toEqual({ pushAndPr: true, linkPr: false, openTicket: false });
  });

  it('Escape and 取消 close the dialog before settling', async () => {
    mockFetch(() => ({ body: OPTIONS_JIRA }));
    open(jiraQuest());
    await screen.findByLabelText('推上分支並開 PR');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useGame.getState().ui.settlementQuestId).toBeUndefined();
  });
});

describe('RejectDialog', () => {
  it('requires feedback, posts it, applies the returned quest and closes', async () => {
    const q = quest({ id: 'r' });
    useGame.setState({ quests: { r: q } });
    const fn = mockFetch(() => ({ body: { ...q, status: 'open', rejections: 1 } }));
    const onClose = vi.fn();
    render(<RejectDialog quest={q} onClose={onClose} />);
    const submit = screen.getByRole('button', { name: '退回委託' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('退回理由'), { target: { value: '   ' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('退回理由'), { target: { value: '測試沒過' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(posts(fn, '/reject')).toHaveLength(1);
    expect(bodyOf(posts(fn, '/reject')[0]!)).toEqual({ feedback: '測試沒過' });
    expect(useGame.getState().quests['r']?.rejections).toBe(1);
  });

  it('shows the server error and stays open', async () => {
    const q = quest({ id: 'r' });
    mockFetch(() => ({ status: 409, body: { error: '委託不在待驗收' } }));
    const onClose = vi.fn();
    render(<RejectDialog quest={q} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('退回理由'), { target: { value: '不行' } });
    fireEvent.click(screen.getByRole('button', { name: '退回委託' }));
    expect((await screen.findByRole('alert')).textContent).toContain('委託不在待驗收');
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '退回委託' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables inputs and ignores Escape while pending', async () => {
    const q = quest({ id: 'r' });
    mockFetch(() => new Promise<Reply>(() => undefined));
    const onClose = vi.fn();
    render(<RejectDialog quest={q} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('退回理由'), { target: { value: '不行' } });
    fireEvent.click(screen.getByRole('button', { name: '退回委託' }));
    await waitFor(() => expect((screen.getByLabelText('退回理由') as HTMLTextAreaElement).disabled).toBe(true));
    for (const el of screen.getAllByRole('button')) expect((el as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
