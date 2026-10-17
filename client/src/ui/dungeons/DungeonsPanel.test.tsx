import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Dungeon } from '@loc/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState, useGame } from '../../state/store';
import { DungeonsPanel } from './DungeonsPanel';

const registered: Dungeon = { id: 'd1', name: 'shop-api', path: '/dev/shop-api', githubRepo: 'acme/shop-api' };

function mockFetch(handler: (path: string, init: RequestInit) => { status?: number; body?: unknown }) {
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const { status = 200, body } = handler(String(url).replace(/^\/api/, ''), init);
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

describe('DungeonsPanel', () => {
  it('lists registered dungeons with name, path and GitHub repo, and scan results not yet registered', async () => {
    mockFetch((path) => {
      if (path === '/dungeons') return { body: [registered] };
      return { body: [{ name: 'shop-api', path: '/dev/shop-api' }, { name: 'tools', path: '/dev/tools', githubRepo: 'acme/tools' }] };
    });
    render(<DungeonsPanel />);
    expect(await screen.findByText('/dev/tools')).toBeTruthy();
    expect(screen.getByText('GitHub：acme/shop-api')).toBeTruthy();
    // shop-api is already registered, so it appears only once (in the registered list)
    expect(screen.getAllByText('/dev/shop-api')).toHaveLength(1);
  });

  it('registers the checked scan results', async () => {
    const fetchFn = mockFetch((path, init) => {
      if (path === '/dungeons' && init.method === 'POST') {
        return { status: 201, body: { id: 'd9', name: 'tools', path: JSON.parse(String(init.body)).path } };
      }
      if (path === '/dungeons') return { body: [] };
      return { body: [{ name: 'tools', path: '/dev/tools' }] };
    });
    render(<DungeonsPanel />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /tools/ }));
    fireEvent.click(screen.getByRole('button', { name: '登記所選' }));
    await waitFor(() => expect(useGame.getState().dungeons['d9']).toBeTruthy());
    const post = fetchFn.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(post[1]?.body))).toEqual({ path: '/dev/tools' });
  });

  it('registers a manually typed path and shows the server error for a non-git folder', async () => {
    mockFetch((path, init) => {
      if (path === '/dungeons' && init.method === 'POST') return { status: 400, body: { error: '這不是 git 專案' } };
      if (path === '/dungeons') return { body: [] };
      return { body: [] };
    });
    render(<DungeonsPanel />);
    fireEvent.change(screen.getByLabelText('專案路徑'), { target: { value: '/tmp/nope' } });
    fireEvent.click(screen.getByRole('button', { name: '登記' }));
    expect((await screen.findByRole('alert')).textContent).toContain('這不是 git 專案');
  });

  it('removes a dungeon locally after DELETE (R18: no broadcast)', async () => {
    useGame.setState({ dungeons: { d1: registered } });
    const fetchFn = mockFetch((path, init) => {
      if (init.method === 'DELETE') return { status: 204 };
      if (path === '/dungeons') return { body: [registered] };
      return { body: [] };
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DungeonsPanel />);
    const item = (await screen.findByText('/dev/shop-api')).closest('li')!;
    fireEvent.click(within(item).getByRole('button', { name: '移除' }));
    await waitFor(() => expect(useGame.getState().dungeons['d1']).toBeUndefined());
    expect(fetchFn.mock.calls.some(([u, i]) => u === '/api/dungeons/d1' && i?.method === 'DELETE')).toBe(true);
    expect(screen.queryByText('/dev/shop-api')).toBeNull();
  });

  it('盤點倉庫 posts the refresh and shows the connector count, or the server error', async () => {
    let fail = false;
    const fetchFn = mockFetch((path, init) => {
      if (path === '/inventory/refresh' && init.method === 'POST') {
        return fail
          ? { status: 502, body: { error: '倉庫盤點失敗：連線逾時' } }
          : {
              body: [
                { name: 'claude.ai Atlassian', prefix: 'claude_ai_Atlassian', status: 'connected' },
                { name: 'claude.ai Slack', prefix: 'claude_ai_Slack', status: 'needs-auth' },
              ],
            };
      }
      return { body: [] };
    });
    render(<DungeonsPanel />);
    fireEvent.click(screen.getByRole('button', { name: '盤點倉庫' }));
    expect((await screen.findByRole('status')).textContent).toBe('找到 2 個 connector（1 個已連線）');
    expect(fetchFn.mock.calls.some(([url, init]) => String(url) === '/api/inventory/refresh' && init?.method === 'POST')).toBe(true);

    fail = true;
    fireEvent.click(screen.getByRole('button', { name: '盤點倉庫' }));
    await waitFor(() => expect(screen.getAllByRole('alert').some((a) => a.textContent === '倉庫盤點失敗：連線逾時')).toBe(true));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
