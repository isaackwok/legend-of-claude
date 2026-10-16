import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, getToken } from './http';

beforeEach(() => {
  sessionStorage.clear();
  history.replaceState(null, '', '/');
});
afterEach(() => vi.unstubAllGlobals());

describe('getToken', () => {
  it('moves the token from the URL into sessionStorage and scrubs the URL', () => {
    history.replaceState(null, '', '/?token=abc&x=1#h');
    expect(getToken()).toBe('abc');
    expect(location.search).toBe('?x=1');
    expect(location.hash).toBe('#h');
    expect(getToken()).toBe('abc');
  });
  it('returns empty string with no token', () => {
    expect(getToken()).toBe('');
  });
});

describe('api', () => {
  it('adds the Bearer header and parses JSON', async () => {
    sessionStorage.setItem('loc.token', 'tok');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api('/x', { method: 'POST', body: '{}' })).resolves.toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/x');
    const h = new Headers(init.headers);
    expect(h.get('Authorization')).toBe('Bearer tok');
    expect(h.get('Content-Type')).toBe('application/json');
  });
  it('throws the server error message on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '壞了' }), { status: 400 })));
    await expect(api('/x')).rejects.toThrow('壞了');
  });
  it('falls back to a status message and handles 204', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(api('/x')).rejects.toThrow('500');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(api('/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});
