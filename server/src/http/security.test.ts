import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { Preflight, Snapshot } from '@loc/shared';
import { loadConfig, type Config } from '../config.js';
import { buildSnapshot } from '../snapshot.js';
import { repos as makeRepos } from '../store/jsonRepo.js';
import { WsHub } from '../ws/hub.js';
import { createApp } from './app.js';

const preflight: Preflight = { ignoredEnvVars: [], loggedIn: true, warnings: [] };

let dir: string;
let config: Config;
let closers: Array<() => void> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'loc-sec-'));
  config = { ...loadConfig({ LOC_DATA_DIR: dir }) };
});

afterEach(async () => {
  for (const close of closers) close();
  closers = [];
  await rm(dir, { recursive: true, force: true });
});

function makeApp() {
  const repos = makeRepos(dir);
  const getSnapshot = () => buildSnapshot(repos, preflight);
  return { repos, getSnapshot, app: createApp({ config, repos, getSnapshot, getPreflight: () => preflight }) };
}

const HOST = '127.0.0.1:4517';

function withHost(app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }) {
  return {
    request: (path: string, init: RequestInit = {}) =>
      app.request(path, { ...init, headers: { Host: HOST, ...(init.headers as Record<string, string> | undefined) } }),
  };
}

describe('HTTP auth', () => {
  const good = () => ({ Authorization: `Bearer ${config.token}` });

  it('rejects a missing token with 401', async () => {
    const { app: raw } = makeApp();
    const app = withHost(raw);
    expect((await app.request('/api/preflight')).status).toBe(401);
  });

  it('rejects a wrong token with 401 (also same length, and non-Bearer schemes)', async () => {
    const { app: raw } = makeApp();
    const app = withHost(raw);
    const wrong = { Authorization: `Bearer ${'0'.repeat(config.token.length)}` };
    expect((await app.request('/api/preflight', { headers: wrong })).status).toBe(401);
    expect((await app.request('/api/preflight', { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await app.request('/api/preflight', { headers: { Authorization: config.token } })).status).toBe(401);
  });

  it('does not accept the token as a query parameter over HTTP', async () => {
    const { app: raw } = makeApp();
    const app = withHost(raw);
    expect((await app.request(`/api/preflight?token=${config.token}`)).status).toBe(401);
  });

  it('rejects a correct token with a foreign Origin with 403', async () => {
    const { app: raw } = makeApp();
    const app = withHost(raw);
    const res = await app.request('/api/preflight', { headers: { ...good(), Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  it('accepts a correct token with an allowed Origin', async () => {
    const { app: raw } = makeApp();
    const app = withHost(raw);
    const res = await app.request('/api/preflight', { headers: { ...good(), Origin: config.allowedOrigins[0]! } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(preflight);
  });

  it('rejects empty, "null", trailing-slash and case-variant Origins with 403', async () => {
    const { app: raw } = makeApp();
    const app = withHost(raw);
    for (const origin of ['', 'null', 'http://localhost:4518/', 'HTTP://LOCALHOST:4518', 'http://localhost:4518.evil.example']) {
      const res = await app.request('/api/preflight', { headers: { ...good(), Origin: origin } });
      expect(res.status, `Origin ${JSON.stringify(origin)}`).toBe(403);
    }
  });

  it('answers 401 for an unknown /api path without a token', async () => {
    const { app: raw } = makeApp();
    expect((await withHost(raw).request('/api/nope')).status).toBe(401);
  });

  it('accepts a correct token without an Origin (server-side tools)', async () => {
    const { app: raw } = makeApp();
    const app = withHost(raw);
    expect((await app.request('/api/preflight', { headers: good() })).status).toBe(200);
  });
});


describe('HTTP Host allowlist', () => {
  const headers = (host?: string) => ({ Authorization: `Bearer ${config.token}`, ...(host ? { Host: host } : {}) });

  it('accepts loopback hosts on the server and client ports (incl. a dev proxy)', async () => {
    const { app } = makeApp();
    for (const host of ['127.0.0.1:4517', 'localhost:4517', '127.0.0.1:4518', 'localhost:4518']) {
      expect((await app.request('/api/preflight', { headers: headers(host) })).status, host).toBe(200);
    }
  });

  it('rejects other hosts with 403, even with a correct token (DNS rebinding)', async () => {
    const { app } = makeApp();
    for (const host of ['evil.example', 'evil.example:4517', '127.0.0.1', '127.0.0.1:9999', 'localhost.evil.example:4517', '[::1]:4517']) {
      expect((await app.request('/api/preflight', { headers: headers(host) })).status, host).toBe(403);
    }
    expect((await app.request('/api/preflight', { headers: headers() })).status).toBe(403);
  });

  it('checks Host before auth', async () => {
    const { app } = makeApp();
    expect((await app.request('/api/preflight', { headers: { Host: 'evil.example' } })).status).toBe(403);
  });
});

describe('WebSocket auth', () => {
  async function start(snapshotFn?: () => Promise<Snapshot>) {
    const { app, getSnapshot } = makeApp();
    const hub = new WsHub(snapshotFn ?? getSnapshot);
    const server = await new Promise<Server>((resolve) => {
      const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s as Server));
    });
    hub.attach(server, config);
    closers.push(() => hub.close(), () => server.close());
    return { port: (server.address() as AddressInfo).port, hub };
  }

  function connect(port: number, query: string, origin?: string, host = HOST, path = '/ws') {
    return new WebSocket(`ws://127.0.0.1:${port}${path}${query}`, { headers: { Host: host }, ...(origin !== undefined ? { origin } : {}) });
  }

  function rejectedStatus(ws: WebSocket): Promise<number> {
    return new Promise((resolve, reject) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => reject(new Error('upgrade should have been rejected')));
      ws.on('error', () => undefined);
    });
  }

  it('rejects an upgrade with a wrong token (401)', async () => {
    const { port } = await start();
    expect(await rejectedStatus(connect(port, '?token=wrong', config.allowedOrigins[0]))).toBe(401);
  });

  it('rejects an upgrade with no token (401)', async () => {
    const { port } = await start();
    expect(await rejectedStatus(connect(port, '', config.allowedOrigins[0]))).toBe(401);
  });

  it('rejects an upgrade with a bad Origin (403)', async () => {
    const { port } = await start();
    expect(await rejectedStatus(connect(port, `?token=${config.token}`, 'https://evil.example'))).toBe(403);
  });

  it('rejects a bad Origin even with a valid token, and the odd Origin spellings (403)', async () => {
    const { port } = await start();
    for (const origin of ['null', 'http://localhost:4518/', 'HTTP://LOCALHOST:4518']) {
      expect(await rejectedStatus(connect(port, `?token=${config.token}`, origin)), origin).toBe(403);
    }
  });

  it('rejects a non-/ws path with 404', async () => {
    const { port } = await start();
    expect(await rejectedStatus(connect(port, `?token=${config.token}`, config.allowedOrigins[0], HOST, '/other'))).toBe(404);
  });

  it('rejects a disallowed Host with 403, accepts localhost:4518 (proxied)', async () => {
    const { port } = await start();
    expect(await rejectedStatus(connect(port, `?token=${config.token}`, config.allowedOrigins[0], 'evil.example'))).toBe(403);
    const ws = connect(port, `?token=${config.token}`, config.allowedOrigins[0], 'localhost:4518');
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.close();
  });

  it('delivers the snapshot first even when a broadcast happens while it is still being built', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { port, hub } = await start(async () => {
      await gate;
      return { quests: [], npcs: [], dungeons: [], approvals: [], preflight };
    });
    const ws = connect(port, `?token=${config.token}`, config.allowedOrigins[0]);
    const messages: Array<{ type: string }> = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data))));
    await new Promise((resolve) => ws.on('open', resolve));
    hub.broadcast({ type: 'approval_resolved', id: 'early' });
    await new Promise((r) => setTimeout(r, 30));
    expect(messages).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages.map((m) => m.type)).toEqual(['snapshot', 'approval_resolved']);
    hub.broadcast({ type: 'approval_resolved', id: 'late' });
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    ws.close();
  });

  it('sends a snapshot first to a correct connection, then broadcasts', async () => {
    const { port, hub } = await start();
    const ws = connect(port, `?token=${config.token}`, config.allowedOrigins[0]);
    const messages: unknown[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data))));
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toEqual({ type: 'snapshot', quests: [], npcs: [], dungeons: [], approvals: [], preflight });
    hub.broadcast({ type: 'approval_resolved', id: 'a1' });
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]).toEqual({ type: 'approval_resolved', id: 'a1' });
    ws.close();
  });

  it('accepts a correct token without an Origin header', async () => {
    const { port } = await start();
    const ws = connect(port, `?token=${config.token}`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.close();
  });
});
