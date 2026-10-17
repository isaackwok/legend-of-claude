import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Preflight, SessionListItem, TranscriptMessage } from '@loc/shared';
import { fakeQuery } from '../../../test/fakeQuery.js';
import { ApprovalBroker } from '../../agent/approvals.js';
import type { QueryFn } from '../../agent/queryFn.js';
import { ChatService } from '../../chats/service.js';
import { ClerkService } from '../../clerk/clerk.js';
import { loadConfig, type Config } from '../../config.js';
import { seedNpcs } from '../../npcs/seeds.js';
import { QuestService } from '../../quests/service.js';
import { buildSnapshot } from '../../snapshot.js';
import { FileSessionStore } from '../../store/fileSessionStore.js';
import { repos as makeRepos, type Repos } from '../../store/jsonRepo.js';
import { createApp } from '../app.js';

const preflight: Preflight = { ignoredEnvVars: [], loggedIn: true, warnings: [] };
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

let tmp: string;
let dataDir: string;
let config: Config;
let repos: Repos;
let sessionStore: FileSessionStore;
let quests: QuestService;
let chats: ChatService;
let app: ReturnType<typeof createApp>;

function build(queryFn: QueryFn): void {
  const broker = new ApprovalBroker();
  const hub = { broadcast: () => undefined };
  quests = new QuestService({ repos, hub, broker, queryFn: fakeQuery([]).fn, dataDir, sessionStore, env: {} });
  const clerk = new ClerkService({ repos, hub, broker, queryFn: fakeQuery([]).fn, dataDir, sessionStore, quests, env: {} });
  chats = new ChatService({ repos, hub, broker, queryFn, dataDir, sessionStore, env: {} });
  app = createApp({ config, repos, hub, getSnapshot: () => buildSnapshot(repos, preflight, broker.list()), getPreflight: () => preflight, quests, broker, clerk, chats, sessionStore });
}

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'loc-sess-')));
  dataDir = join(tmp, 'data');
  config = loadConfig({ LOC_DATA_DIR: dataDir });
  repos = makeRepos(dataDir);
  sessionStore = new FileSessionStore(join(dataDir, 'sessions'));
  for (const npc of seedNpcs()) await repos.npcs.put(npc);
  build(fakeQuery([]).fn);
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

const req = (path: string, body?: unknown) =>
  app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Host: '127.0.0.1:4517', Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** The store keys a session by its cwd with every non-alphanumeric character turned into `-`. */
const projectKeyOf = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

describe('GET /api/sessions', () => {
  it('lists newest first, filters by npc, and puts live sessions on top', async () => {
    await repos.sessions.put({ id: 'old', npcId: 'lina', title: '舊的', cwd: tmp, updatedAt: 100 });
    await repos.sessions.put({ id: 'new', npcId: 'lina', title: '新的', cwd: tmp, updatedAt: 300, questId: 'q1', costUsd: 1.5 });
    await repos.sessions.put({ id: 'mid', npcId: 'alex', title: '別人的', cwd: tmp, updatedAt: 200 });

    let res = await req('/api/sessions');
    expect(res.status).toBe(200);
    expect(((await res.json()) as SessionListItem[]).map((s) => [s.id, s.live])).toEqual([['new', false], ['mid', false], ['old', false]]);

    res = await req('/api/sessions?npcId=lina');
    const lina = (await res.json()) as SessionListItem[];
    expect(lina.map((s) => s.id)).toEqual(['new', 'old']);
    expect(lina[0]).toMatchObject({ npcId: 'lina', questId: 'q1', title: '新的', cwd: tmp, costUsd: 1.5, live: false });
  });

  it('marks a running chat live and lists it first, even when it is older', async () => {
    await repos.sessions.put({ id: 'recent', npcId: 'lina', title: '最近', cwd: tmp, updatedAt: Date.now() + 100_000 });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    build(((): QueryFn => {
      return (() => {
        const q = (async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'live-1', permissionMode: 'auto' };
          await gate;
          yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.1, session_id: 'live-1' };
        })();
        return Object.assign(q, { interrupt: async () => undefined, close: () => undefined });
      }) as unknown as QueryFn;
    })());
    // Index entry of the running chat is written with updatedAt = now, i.e. older than `recent`.
    const res = await req('/api/chats', { npcId: 'lina', text: '正在聊' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: 'live-1' });

    const during = (await (await req('/api/sessions')).json()) as SessionListItem[];
    expect(during.map((s) => [s.id, s.live])).toEqual([['live-1', true], ['recent', false]]);

    open();
    await chats.idle();
    const after = (await (await req('/api/sessions')).json()) as SessionListItem[];
    expect(after.map((s) => [s.id, s.live])).toEqual([['recent', false], ['live-1', false]]);
  });
});

describe('GET /api/sessions/:id/messages', () => {
  it('404s an unknown session', async () => {
    const res = await req('/api/sessions/nope/messages');
    expect([res.status, await res.json()]).toEqual([404, { error: '找不到這份冒險日誌' }]);
  });

  it('reads the transcript from the session store as role + blocks', async () => {
    const cwd = join(tmp, 'work');
    await repos.sessions.put({ id: UUID_A, npcId: 'alex', title: '修登入', cwd, updatedAt: 1 });
    const t = (n: number) => `2026-10-16T00:00:0${n}.000Z`;
    await sessionStore.append({ projectKey: projectKeyOf(cwd), sessionId: UUID_A }, [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId: UUID_A, timestamp: t(0), cwd, message: { role: 'user', content: '幫我看登入' } },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: UUID_A,
        timestamp: t(1),
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '嗯', signature: 's' }, { type: 'text', text: '我來讀檔' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/w/login.ts' } }] },
      },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: UUID_A, timestamp: t(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x'.repeat(2500) }] } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u2', sessionId: UUID_A, timestamp: t(3), message: { role: 'assistant', content: [{ type: 'text', text: '看完了' }] } },
    ]);
    // Another session in the same project stays out of it.
    await sessionStore.append({ projectKey: projectKeyOf(cwd), sessionId: UUID_B }, [
      { type: 'user', uuid: 'x1', parentUuid: null, sessionId: UUID_B, timestamp: t(0), cwd, message: { role: 'user', content: '別的對話' } },
    ]);

    const res = await req(`/api/sessions/${UUID_A}/messages`);
    expect(res.status).toBe(200);
    const out = (await res.json()) as TranscriptMessage[];
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ role: 'user', blocks: [{ type: 'text', text: '幫我看登入' }] });
    expect(out[1]).toEqual({
      role: 'assistant',
      blocks: [
        { type: 'text', text: '我來讀檔' },
        { type: 'tool_use', id: 'tu1', name: 'Read', summary: '/w/login.ts', input: { file_path: '/w/login.ts' } },
      ],
    });
    expect(out[2]).toEqual({ role: 'user', blocks: [{ type: 'tool_result', toolUseId: 'tu1', isError: false, output: 'x'.repeat(2000) }] });
    expect(out[3]).toEqual({ role: 'assistant', blocks: [{ type: 'text', text: '看完了' }] });
  });

  it('returns an empty log for an indexed session the store has nothing for', async () => {
    await repos.sessions.put({ id: UUID_A, npcId: 'alex', title: '空的', cwd: join(tmp, 'work'), updatedAt: 1 });
    const res = await req(`/api/sessions/${UUID_A}/messages`);
    expect([res.status, await res.json()]).toEqual([200, []]);
  });
});

describe('POST /api/chats', () => {
  it('validates the body and maps chat errors to status codes', async () => {
    for (const body of [{}, { npcId: 'alex' }, { npcId: 'alex', text: '  ' }, { text: '嗨' }, { npcId: 'alex', text: '嗨', sessionId: 3 }]) {
      expect((await req('/api/chats', body)).status).toBe(400);
    }
    let res = await req('/api/chats', { npcId: 'clerk', text: '嗨' });
    expect(res.status).toBe(400);
    res = await req('/api/chats', { npcId: 'nobody', text: '嗨' });
    expect([res.status, await res.json()]).toEqual([404, { error: '找不到這位冒險者' }]);
    await repos.npcs.put({ ...(await repos.npcs.get('alex'))!, busyQuestId: 'q1' });
    res = await req('/api/chats', { npcId: 'alex', text: '嗨' });
    expect([res.status, await res.json()]).toEqual([409, { error: '阿列克正在冒險，請到水晶球傳信' }]);
  });
});
