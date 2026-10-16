import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameEvent, ServerMessage } from '@loc/shared';
import { fakeQuery } from '../../test/fakeQuery.js';
import { ApprovalBroker } from '../agent/approvals.js';
import type { QueryFn } from '../agent/queryFn.js';
import { seedNpcs } from '../npcs/seeds.js';
import { FileSessionStore } from '../store/fileSessionStore.js';
import { repos as makeRepos, type Repos } from '../store/jsonRepo.js';
import { ChatError, ChatService } from './service.js';

const init = (sessionId = 's-1', permissionMode = 'auto') => ({ type: 'system', subtype: 'init', session_id: sessionId, permissionMode });
const assistantText = (text: string, sessionId = 's-1') => ({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const success = (cost = 0.5, sessionId = 's-1') => ({ type: 'result', subtype: 'success', is_error: false, result: '好的', total_cost_usd: cost, session_id: sessionId });

let tmp: string;
let dataDir: string;
let r: Repos;
let messages: ServerMessage[];

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'loc-chat-')));
  dataDir = join(tmp, 'data');
  r = makeRepos(dataDir);
  for (const npc of seedNpcs()) await r.npcs.put(npc);
  messages = [];
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

function service(queryFn: QueryFn): ChatService {
  return new ChatService({
    repos: r,
    hub: { broadcast: (m) => void messages.push(m) },
    broker: new ApprovalBroker(),
    queryFn,
    dataDir,
    sessionStore: new FileSessionStore(join(dataDir, 'sessions')),
    env: {},
  });
}

/** A query that sends init, then holds its reply until `open()` — a chat turn that is still running. */
function gated(sessionId = 's-1') {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const calls: Options[] = [];
  const fn = ((params: { options?: Options }) => {
    calls.push(params.options ?? {});
    const q = (async function* () {
      yield init(sessionId);
      await gate;
      yield success(0.2, sessionId);
    })();
    return Object.assign(q, { interrupt: async () => undefined, close: () => undefined });
  }) as unknown as QueryFn;
  return { fn, calls, open };
}

describe('ChatService.say', () => {
  it('starts a read-only chat in the tavern and indexes the session', async () => {
    const fake = fakeQuery([init(), assistantText('哈囉'), success(0.5)]);
    const svc = service(fake.fn);
    const text = '你好，請幫我看看這個專案的登入流程是怎麼運作的，順便說明資料庫設計';
    const { sessionId } = await svc.say({ npcId: 'alex', text });
    await svc.idle();

    expect(sessionId).toBe('s-1');
    const options = fake.calls[0]!;
    // Alex is a warrior (not read-only), but chats never edit files.
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']));
    expect(options.resume).toBeUndefined();
    expect(options.cwd).toBe(join(dataDir, 'tavern'));
    expect((await stat(join(dataDir, 'tavern'))).mode & 0o777).toBe(0o700);
    expect(options.sessionStore).toBeDefined();
    expect(options.permissionMode).toBe('auto');

    const prompt = fake.inputs[0]!.message.content;
    expect(prompt).toBe(text);

    const entry = await r.sessions.get('s-1');
    expect(entry).toMatchObject({ id: 's-1', npcId: 'alex', cwd: join(dataDir, 'tavern'), costUsd: 0.5 });
    expect(entry!.questId).toBeUndefined();
    expect(entry!.title).toBe([...text].slice(0, 30).join(''));
    expect([...entry!.title]).toHaveLength(30);
    // Chatting never marks the NPC as adventuring.
    expect((await r.npcs.get('alex'))!.busyQuestId).toBeUndefined();
  });

  it('broadcasts the reply as game events without a quest', async () => {
    const svc = service(fakeQuery([init(), assistantText('哈囉'), success()]).fn);
    await svc.say({ npcId: 'lina', text: '嗨' });
    await svc.idle();
    const events = messages.flatMap((m) => (m.type === 'event' ? [m.event] : []));
    expect(events.map((e: GameEvent) => e.kind)).toEqual(['text', 'result']);
    expect(events.every((e) => e.npcId === 'lina' && e.questId === undefined && e.sessionId === 's-1')).toBe(true);
    expect(events[0]!.label).toBe('哈囉');
  });

  it('chats in the home dungeon when the npc has one', async () => {
    await r.dungeons.put({ id: 'd1', name: 'repo', path: join(tmp, 'repo') });
    await r.npcs.put({ ...(await r.npcs.get('alex'))!, homeDungeonId: 'd1' });
    const fake = fakeQuery([init(), success()]);
    const svc = service(fake.fn);
    await svc.say({ npcId: 'alex', text: '嗨' });
    await svc.idle();
    expect(fake.calls[0]!.cwd).toBe(join(tmp, 'repo'));
    expect((await r.sessions.get('s-1'))!.cwd).toBe(join(tmp, 'repo'));
  });

  it('resumes the same session with the same cwd, keeping the title and the highest cost', async () => {
    const first = fakeQuery([init(), success(0.5)]);
    await service(first.fn).say({ npcId: 'lina', text: '第一句話' });
    const before = (await r.sessions.get('s-1'))!;

    // Costs are session totals: a later, lower report (e.g. a recalled turn) must not shrink the stored one.
    const second = fakeQuery([init(), success(0.3)]);
    const svc2 = service(second.fn);
    const res = await svc2.say({ npcId: 'lina', text: '第二句話', sessionId: 's-1' });
    await svc2.idle();
    expect(res).toEqual({ sessionId: 's-1' });
    expect(second.calls[0]!.resume).toBe('s-1');
    expect(second.calls[0]!.cwd).toBe(before.cwd);
    expect(second.calls[0]!.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'Write']));
    expect(second.inputs[0]!.message.content).toBe('第二句話');
    const after = (await r.sessions.get('s-1'))!;
    expect(after.title).toBe('第一句話');
    expect(after.costUsd).toBe(0.5);
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);

    const third = fakeQuery([init(), success(0.9)]);
    const svc3 = service(third.fn);
    await svc3.say({ npcId: 'lina', text: '第三句話', sessionId: 's-1' });
    await svc3.idle();
    expect((await r.sessions.get('s-1'))!.costUsd).toBe(0.9);
    expect(await r.sessions.list()).toHaveLength(1);
  });

  it('refuses an npc that is out on a quest, pointing to the crystal ball', async () => {
    await r.npcs.put({ ...(await r.npcs.get('alex'))!, busyQuestId: 'q1' });
    const fake = fakeQuery([init(), success()]);
    const err = await service(fake.fn).say({ npcId: 'alex', text: '嗨' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatError);
    expect(err).toMatchObject({ status: 409, message: '阿列克正在冒險，請到水晶球傳信' });
    expect(fake.calls).toHaveLength(0);
  });

  it('does not chat with the clerk, an unknown npc, or an empty message', async () => {
    const fake = fakeQuery([init(), success()]);
    const svc = service(fake.fn);
    await expect(svc.say({ npcId: 'clerk', text: '嗨' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.say({ npcId: 'nobody', text: '嗨' })).rejects.toMatchObject({ status: 404 });
    await expect(svc.say({ npcId: 'alex', text: '   ' })).rejects.toMatchObject({ status: 400 });
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses unknown sessions, another npc\'s sessions and quest sessions', async () => {
    const fake = fakeQuery([init(), success()]);
    const svc = service(fake.fn);
    await expect(svc.say({ npcId: 'lina', text: '嗨', sessionId: 'ghost' })).rejects.toMatchObject({ status: 404 });
    await r.sessions.put({ id: 'a', npcId: 'alex', title: 't', cwd: tmp, updatedAt: 1 });
    await expect(svc.say({ npcId: 'lina', text: '嗨', sessionId: 'a' })).rejects.toMatchObject({ status: 400 });
    await r.sessions.put({ id: 'b', npcId: 'lina', questId: 'q1', title: 't', cwd: tmp, updatedAt: 1 });
    await expect(svc.say({ npcId: 'lina', text: '嗨', sessionId: 'b' })).rejects.toMatchObject({ status: 400 });
    expect(fake.calls).toHaveLength(0);
    // The failed attempts left no claim behind.
    expect(svc.liveSessionIds()).toEqual([]);
  });

  it('answers as soon as the session started, while the reply is still running', async () => {
    const g = gated();
    const svc = service(g.fn);
    const { sessionId } = await svc.say({ npcId: 'lina', text: '嗨' });
    expect(svc.liveSessionIds()).toEqual([sessionId]);
    expect(await r.sessions.get(sessionId)).toMatchObject({ npcId: 'lina', title: '嗨' });

    // Same session, still replying -> refused; another new chat is fine.
    await expect(svc.say({ npcId: 'lina', text: '再問', sessionId })).rejects.toMatchObject({ status: 409, message: '莉娜還在回話中' });
    expect(g.calls).toHaveLength(1);

    g.open();
    await svc.idle();
    expect(svc.liveSessionIds()).toEqual([]);
    expect((await r.sessions.get(sessionId))!.costUsd).toBe(0.2);
  });

  it('rejects two simultaneous sends on one session', async () => {
    await r.sessions.put({ id: 's-1', npcId: 'lina', title: 't', cwd: tmp, updatedAt: 1 });
    const g = gated();
    const svc = service(g.fn);
    const results = await Promise.allSettled([svc.say({ npcId: 'lina', text: '一', sessionId: 's-1' }), svc.say({ npcId: 'lina', text: '二', sessionId: 's-1' })]);
    expect(results.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    g.open();
    await svc.idle();
    expect(g.calls).toHaveLength(1);
  });

  it('answers an error when the session fails before init, leaving no index entry or claim', async () => {
    const failing = (() => {
      const q = (async function* () {
        throw new Error('not logged in');
      })();
      return Object.assign(q, { interrupt: async () => undefined, close: () => undefined });
    }) as unknown as QueryFn;
    await r.sessions.put({ id: 's-1', npcId: 'lina', title: 't', cwd: tmp, updatedAt: 1 });
    const svc = service(failing);
    const err = await svc.say({ npcId: 'lina', text: '嗨', sessionId: 's-1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatError);
    expect(err).toMatchObject({ status: 502 });
    expect((err as Error).message).toContain('not logged in');
    expect(svc.liveSessionIds()).toEqual([]);
    // The claim is free again: a retry reaches the SDK instead of being told the NPC is still replying.
    await expect(svc.say({ npcId: 'lina', text: '嗨', sessionId: 's-1' })).rejects.toMatchObject({ status: 502 });
    expect(await r.sessions.list()).toHaveLength(1);
  });
});
