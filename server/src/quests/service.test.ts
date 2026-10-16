import { execFile } from 'node:child_process';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidTransitionError, type Quest, type ServerMessage } from '@loc/shared';
import { fakeQuery, type FakeStep } from '../../test/fakeQuery.js';
import { ApprovalBroker } from '../agent/approvals.js';
import type { QueryFn } from '../agent/queryFn.js';
import { createWorktree, worktreeExists } from '../git/worktree.js';
import { seedNpcs } from '../npcs/seeds.js';
import { FileSessionStore } from '../store/fileSessionStore.js';
import { repos as makeRepos, type Repos } from '../store/jsonRepo.js';
import { handoverBrief, questBrief, questInstructions } from './prompts.js';
import { ConflictError, NotFoundError, NpcBusyError, QuestService, ValidationError } from './service.js';

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();

const init = (permissionMode = 'auto', sessionId = 's-1') => ({ type: 'system', subtype: 'init', session_id: sessionId, permissionMode });
const success = (sessionId = 's-1') => ({ type: 'result', subtype: 'success', is_error: false, result: '修好了登入按鈕', total_cost_usd: 0.5, session_id: sessionId });
const waitForMessage: FakeStep = { waitForInput: 2 };

let tmp: string;
let repo: string;
let dataDir: string;
let r: Repos;
let messages: ServerMessage[];

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'loc-quest-')));
  repo = join(tmp, 'repo');
  dataDir = join(tmp, 'data');
  await run('git', ['init', '-q', '-b', 'main', repo]);
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await writeFile(join(repo, 'a.txt'), 'one\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'init');
  r = makeRepos(dataDir);
  for (const npc of seedNpcs()) await r.npcs.put(npc);
  await r.dungeons.put({ id: 'd1', name: 'repo', path: repo, defaultBranch: 'main' });
  messages = [];
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

function service(queryFn: QueryFn): QuestService {
  return new QuestService({
    repos: r,
    hub: { broadcast: (m) => void messages.push(m) },
    broker: new ApprovalBroker(),
    queryFn,
    dataDir,
    sessionStore: new FileSessionStore(join(dataDir, 'sessions')),
    env: {},
  });
}

/** Wraps a fake so each query() call first writes `file` into its cwd, like an NPC editing code. */
function writing(fn: QueryFn, file: string): QueryFn {
  return ((params: { prompt: unknown; options?: Options }) => {
    writeFileSync(join(params.options!.cwd!, file), 'new\n');
    return (fn as unknown as (p: unknown) => unknown)(params);
  }) as unknown as QueryFn;
}

/** Hands each query() call to the next fake (a fake's interrupted state is shared by all its calls). */
function sequence(...fakes: QueryFn[]): QueryFn {
  let i = 0;
  return ((p: unknown) => (fakes[Math.min(i++, fakes.length - 1)] as unknown as (x: unknown) => unknown)(p)) as unknown as QueryFn;
}

const promptText = (m: { message: { content: unknown } } | undefined) => m?.message.content as string;

describe('QuestService', () => {
  it('create -> open with default stars', async () => {
    const svc = service(fakeQuery([]).fn);
    const q = await svc.create({ title: '  修好登入  ', body: '登入按鈕沒反應' });
    expect(q).toMatchObject({ title: '修好登入', body: '登入按鈕沒反應', stars: 2, status: 'open', source: { kind: 'local' }, rejections: 0 });
    expect(await r.quests.get(q.id)).toEqual(q);
    expect(messages).toContainEqual({ type: 'quest', quest: q });
    await expect(svc.create({ title: '  ', body: '' })).rejects.toThrow(ValidationError);
    await expect(svc.create({ title: 'x', body: '', stars: 7 as 1 })).rejects.toThrow(ValidationError);
  });

  it('start -> adventuring, then finish -> review with scroll, commit and session index', async () => {
    const fake = fakeQuery([init(), waitForMessage, success()]);
    const svc = service(writing(fake.fn, 'hello.txt'));
    const q = await svc.create({ title: '修好登入', body: '登入按鈕沒反應' });

    const started = await svc.start(q.id, { npcId: 'alex', dungeonId: 'd1' });
    expect(started).toMatchObject({ status: 'adventuring', npcId: 'alex', dungeonId: 'd1', branch: `loc/${q.id}`, baseBranch: 'main' });
    expect(await worktreeExists(started.worktreePath!)).toBe(true);
    expect((await r.npcs.get('alex'))!.busyQuestId).toBe(q.id);

    const opts = fake.calls[0]!;
    expect(opts.cwd).toBe(started.worktreePath);
    expect(opts.permissionMode).toBe('auto');
    expect(opts.resume).toBeUndefined();
    expect(opts.sessionStore).toBeInstanceOf(FileSessionStore);
    const append = (opts.systemPrompt as { append: string }).append;
    expect(append).toContain(questInstructions(`loc/${q.id}`));
    expect(append).not.toContain('登入按鈕沒反應');
    await svc.message(q.id, '記得補測試');
    await svc.settled(q.id);

    expect(promptText(fake.inputs[0])).toBe(questBrief(started, (await r.dungeons.get('d1'))!));
    expect(promptText(fake.inputs[0])).not.toContain('你在獨立分支');
    expect(promptText(fake.inputs[1])).toBe('記得補測試');
    const done = (await r.quests.get(q.id))!;
    expect(done.status).toBe('review');
    expect(done.sessionId).toBe('s-1');
    expect(done.scroll).toContain('修好了登入按鈕');
    expect(done.scroll).toContain('變更：');
    expect(done.scroll).toContain('hello.txt');
    expect((await r.npcs.get('alex'))!.busyQuestId).toBeUndefined();
    expect(await git(started.worktreePath!, 'log', '-1', '--format=%s', `loc/${q.id}`)).toBe('loc: 修好登入');
    expect(await r.sessions.get('s-1')).toMatchObject({ id: 's-1', npcId: 'alex', questId: q.id, title: '修好登入', cwd: started.worktreePath, costUsd: 0.5 });
    expect(messages.some((m) => m.type === 'event' && m.event.kind === 'result' && m.event.questId === q.id)).toBe(true);
    expect(messages).toContainEqual({ type: 'quest', quest: done });
    expect(messages.some((m) => m.type === 'npc' && m.npc.id === 'alex' && m.npc.busyQuestId === q.id)).toBe(true);
    expect(messages.at(-1)).toEqual({ type: 'quest', quest: done });
    expect((svc as unknown as { settledRuns: Map<string, unknown> }).settledRuns.size).toBe(0);
  });

  it('rejects starting a second quest for a busy npc', async () => {
    const fake = fakeQuery([init(), waitForMessage, success()]);
    const svc = service(fake.fn);
    const q1 = await svc.create({ title: '一', body: '' });
    const q2 = await svc.create({ title: '二', body: '' });
    const first = svc.start(q1.id, { npcId: 'alex', dungeonId: 'd1' });
    await expect(svc.start(q2.id, { npcId: 'alex', dungeonId: 'd1' })).rejects.toThrow(new NpcBusyError('阿列克'));
    await first;
    await expect(svc.start(q2.id, { npcId: 'alex', dungeonId: 'd1' })).rejects.toThrow('阿列克正在冒險中');
    await svc.message(q1.id, '繼續');
    await svc.settled(q1.id);
    expect(fake.calls).toHaveLength(1);
    expect((await r.quests.get(q2.id))!.status).toBe('open');
    expect((await r.quests.get(q2.id))!.worktreePath).toBeUndefined();
  });

  it('reports unknown quest / npc / dungeon as NotFoundError and frees the npc', async () => {
    const svc = service(fakeQuery([init(), success()]).fn);
    const q = await svc.create({ title: '一', body: '' });
    await expect(svc.start('nope', { npcId: 'alex', dungeonId: 'd1' })).rejects.toThrow(NotFoundError);
    await expect(svc.start(q.id, { npcId: 'nobody', dungeonId: 'd1' })).rejects.toThrow(NotFoundError);
    await expect(svc.start(q.id, { npcId: 'alex', dungeonId: 'nowhere' })).rejects.toThrow(NotFoundError);
    await svc.start(q.id, { npcId: 'alex', dungeonId: 'd1' });
    await svc.settled(q.id);
    expect((await r.quests.get(q.id))!.status).toBe('review');
  });

  it('reject resumes the same session with the feedback and counts the rejection', async () => {
    const fake = fakeQuery([init(), success()]);
    const svc = service(fake.fn);
    const q = await svc.create({ title: '修好登入', body: '' });
    await svc.start(q.id, { npcId: 'alex', dungeonId: 'd1' });
    await svc.settled(q.id);
    await expect(svc.reject(q.id, '  ')).rejects.toThrow(ValidationError);

    const rejected = await svc.reject(q.id, '測試沒過');
    expect(rejected).toMatchObject({ status: 'adventuring', rejections: 1 });
    expect((await r.npcs.get('alex'))!.busyQuestId).toBe(q.id);
    await svc.settled(q.id);

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.resume).toBe('s-1');
    expect(fake.calls[1]!.cwd).toBe(rejected.worktreePath);
    expect(promptText(fake.inputs.at(-1))).toBe('會長退回了委託：測試沒過');
    expect(await r.quests.get(q.id)).toMatchObject({ status: 'review', rejections: 1, sessionId: 's-1' });
    expect((await r.npcs.get('alex'))!.busyQuestId).toBeUndefined();
  });

  it('recall returns the quest to open with 已被召回 and frees the npc', async () => {
    const fake = fakeQuery([init(), waitForMessage, success()]);
    const svc = service(fake.fn);
    const q = await svc.create({ title: '修好登入', body: '' });
    await svc.start(q.id, { npcId: 'alex', dungeonId: 'd1' });

    const after = await svc.recall(q.id);
    expect(fake.interrupted).toBe(true);
    expect(after.status).toBe('open');
    expect(after.scroll).toContain('已被召回');
    expect((await r.npcs.get('alex'))!.busyQuestId).toBeUndefined();
    await expect(svc.message(q.id, '還在嗎')).rejects.toThrow(ConflictError);
    await expect(svc.recall(q.id)).rejects.toThrow(ConflictError);
  });

  it('liveSessionIds lists the session of a running adventure only while it runs', async () => {
    const svc = service(fakeQuery([init(), waitForMessage, success()]).fn);
    const q = await svc.create({ title: '修好登入', body: '' });
    expect(svc.liveSessionIds()).toEqual([]);
    await svc.start(q.id, { npcId: 'alex', dungeonId: 'd1' });
    // The session id is only known once the SDK sent init.
    await vi.waitFor(() => expect(svc.liveSessionIds()).toEqual(['s-1']));
    await svc.recall(q.id);
    expect(svc.liveSessionIds()).toEqual([]);
  });

  it('a failed run returns the quest to open with 冒險失敗', async () => {
    const fail = { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], total_cost_usd: 0.1, session_id: 's-1' };
    const svc = service(fakeQuery([init(), fail]).fn);
    const q = await svc.create({ title: '修好登入', body: '' });
    await svc.start(q.id, { npcId: 'alex', dungeonId: 'd1' });
    await svc.settled(q.id);
    expect(await r.quests.get(q.id)).toMatchObject({ status: 'open', scroll: '冒險失敗：boom', sessionId: 's-1' });
    expect((await r.npcs.get('alex'))!.busyQuestId).toBeUndefined();
  });

  it('still reaches review when the auto-commit fails, noting it in the scroll', async () => {
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o755);
    const fake = fakeQuery([init(), success()]);
    const svc = service(writing(fake.fn, 'hello.txt'));
    const q = await svc.create({ title: '修好登入', body: '' });
    await svc.start(q.id, { npcId: 'alex', dungeonId: 'd1' });
    await svc.settled(q.id);
    const done = (await r.quests.get(q.id))!;
    expect(done.status).toBe('review');
    expect(done.scroll).toContain('自動提交失敗：');
  });

  it('marks the npc cautious when the session did not get auto mode', async () => {
    const svc = service(fakeQuery([init('default'), success()]).fn);
    const q = await svc.create({ title: '修好登入', body: '' });
    await svc.start(q.id, { npcId: 'alex', dungeonId: 'd1' });
    await svc.settled(q.id);
    expect((await r.npcs.get('alex'))!.cautious).toBe(true);
    expect(messages.some((m) => m.type === 'npc' && m.npc.id === 'alex' && m.npc.cautious === true)).toBe(true);
  });

  it('abandon: open -> abandoned; an adventuring quest cannot be abandoned', async () => {
    const svc = service(fakeQuery([init(), waitForMessage, success()]).fn);
    const q1 = await svc.create({ title: '一', body: '' });
    expect(await svc.abandon(q1.id)).toMatchObject({ status: 'abandoned' });
    await expect(svc.start(q1.id, { npcId: 'alex', dungeonId: 'd1' })).rejects.toThrow(InvalidTransitionError);
    expect((await r.npcs.get('alex'))!.busyQuestId).toBeUndefined();

    const q2 = await svc.create({ title: '二', body: '' });
    await svc.start(q2.id, { npcId: 'alex', dungeonId: 'd1' });
    await expect(svc.abandon(q2.id)).rejects.toThrow(ConflictError);
    await svc.recall(q2.id);
  });

  it('re-start by the same npc resumes; by a different npc starts a fresh session with the earlier scroll', async () => {
    // Calls: 1 alex (recalled), 2 alex resumes (recalled), 3 lina takes over in a fresh session.
    const alexFirst = fakeQuery([init('auto', 's-alex'), waitForMessage, success('s-alex')]);
    const alexAgain = fakeQuery([init('auto', 's-alex'), waitForMessage, success('s-alex')]);
    const linaFake = fakeQuery([init('auto', 's-lina'), success('s-lina')]);
    const svc = service(sequence(alexFirst.fn, alexAgain.fn, linaFake.fn));
    const q = await svc.create({ title: '修好登入', body: '登入按鈕沒反應' });
    const first = await svc.start(q.id, { npcId: 'alex', dungeonId: 'd1' });
    await svc.recall(q.id);

    const again = await svc.start(q.id, { npcId: 'alex', dungeonId: 'd1' });
    expect(again.worktreePath).toBe(first.worktreePath);
    expect(alexFirst.calls[0]!.resume).toBeUndefined();
    expect(alexAgain.calls[0]!.resume).toBe('s-alex');
    expect(promptText(alexAgain.inputs[0])).toBe('會長請你繼續這個委託。');
    await svc.recall(q.id);

    const takenOver = await svc.start(q.id, { npcId: 'lina', dungeonId: 'd1' });
    expect(takenOver.worktreePath).toBe(first.worktreePath);
    expect(linaFake.calls[0]!.resume).toBeUndefined();
    expect(linaFake.calls[0]!.cwd).toBe(first.worktreePath);
    const dungeon = (await r.dungeons.get('d1'))!;
    expect(promptText(linaFake.inputs[0])).toBe(`${questBrief(q, dungeon)}\n\n先前冒險的卷軸：\n已被召回`);
    await svc.settled(q.id);

    expect(await r.quests.get(q.id)).toMatchObject({ status: 'review', npcId: 'lina', sessionId: 's-lina' });
    expect(await r.sessions.get('s-alex')).toMatchObject({ npcId: 'alex', questId: q.id });
    expect(await r.sessions.get('s-lina')).toMatchObject({ npcId: 'lina', questId: q.id, cwd: first.worktreePath });
  });

  it('keeps the cumulative session cost when a later run ends without a result', async () => {
    // Call 1 finishes at 0.5; call 2 (reject, resumes the same session) is recalled before any result.
    const fake = fakeQuery([init(), success()]);
    const blocked = fakeQuery([init(), waitForMessage, success()]);
    const svc = service(sequence(fake.fn, blocked.fn));
    const q = await svc.create({ title: '修好登入', body: '' });
    await svc.start(q.id, { npcId: 'alex', dungeonId: 'd1' });
    await svc.settled(q.id);
    expect((await r.sessions.get('s-1'))!.costUsd).toBe(0.5);

    await svc.reject(q.id, '測試沒過');
    await svc.recall(q.id);
    expect((await r.quests.get(q.id))!.status).toBe('open');
    expect((await r.sessions.get('s-1'))!.costUsd).toBe(0.5);
  });

  it('frees the npc when creating the worktree fails, so it can start another quest', async () => {
    const svc = service(fakeQuery([init(), success()]).fn);
    const q1 = await svc.create({ title: '一', body: '' });
    const q2 = await svc.create({ title: '二', body: '' });
    await git(repo, 'branch', `loc/${q1.id}`);
    await expect(svc.start(q1.id, { npcId: 'alex', dungeonId: 'd1' })).rejects.toThrow(`分支 loc/${q1.id} 已存在`);
    expect((await r.npcs.get('alex'))!.busyQuestId).toBeUndefined();
    expect((await r.quests.get(q1.id))!.status).toBe('open');

    expect(await svc.start(q2.id, { npcId: 'alex', dungeonId: 'd1' })).toMatchObject({ status: 'adventuring', npcId: 'alex' });
    await svc.settled(q2.id);
    expect((await r.quests.get(q2.id))!.status).toBe('review');
  });

  it('frees the npc before the finished quest is broadcast', async () => {
    const svc = service(fakeQuery([init(), success()]).fn);
    const q = await svc.create({ title: '一', body: '' });
    await svc.start(q.id, { npcId: 'alex', dungeonId: 'd1' });
    await svc.settled(q.id);
    const reviewAt = messages.findIndex((m) => m.type === 'quest' && m.quest.status === 'review');
    const freedAt = messages.findIndex((m) => m.type === 'npc' && m.npc.id === 'alex' && m.npc.busyQuestId === undefined);
    expect(reviewAt).toBeGreaterThan(-1);
    expect(freedAt).toBeGreaterThan(-1);
    expect(freedAt).toBeLessThan(reviewAt);
  });

  it('recoverInterrupted reopens adventuring quests, frees npcs, keeps the worktree, and resumes the session', async () => {
    const id = 'q-interrupted';
    const { worktreePath, baseBranch } = await createWorktree(repo, dataDir, `loc/${id}`);
    const stuck: Quest = {
      id, title: '修好登入', body: '', stars: 2, status: 'adventuring', source: { kind: 'local' },
      npcId: 'alex', dungeonId: 'd1', branch: `loc/${id}`, worktreePath, baseBranch,
      sessionId: 's-old', rejections: 0, createdAt: 1, updatedAt: 1,
    };
    await r.quests.put(stuck);
    await r.npcs.put({ ...(await r.npcs.get('alex'))!, busyQuestId: id });

    const fake = fakeQuery([init('auto', 's-old'), success('s-old')]);
    const svc = service(fake.fn);
    await svc.recoverInterrupted();

    const reopened = (await r.quests.get(id))!;
    expect(reopened.status).toBe('open');
    expect(reopened.scroll).toContain('冒險被中斷');
    expect((await r.npcs.get('alex'))!.busyQuestId).toBeUndefined();
    expect(await worktreeExists(worktreePath)).toBe(true);

    const restarted = await svc.start(id, { npcId: 'alex', dungeonId: 'd1' });
    expect(restarted.worktreePath).toBe(worktreePath);
    expect(fake.calls[0]!.resume).toBe('s-old');
    expect(promptText(fake.inputs[0])).toBe('會長請你繼續這個委託。');
    await svc.settled(id);
    expect((await r.quests.get(id))!.status).toBe('review');
  });
});

describe('quest prompts', () => {
  it('questBrief carries the quest content; questInstructions the standing instructions', () => {
    const q: Quest = {
      id: 'abcdef123', title: '修好登入', body: '登入按鈕沒反應', stars: 3, status: 'open',
      source: { kind: 'jira', key: 'PROJ-7', url: 'https://jira/browse/PROJ-7' }, branch: 'loc/PROJ-7-abcdef',
      rejections: 0, createdAt: 0, updatedAt: 0,
    };
    const dungeon = { id: 'd1', name: 'repo', path: '/x' };
    const brief = questBrief(q, dungeon);
    for (const part of ['修好登入', '登入按鈕沒反應', 'PROJ-7']) expect(brief).toContain(part);
    expect(brief).not.toContain('你在獨立分支');
    const rules = questInstructions('loc/PROJ-7-abcdef');
    for (const part of ['你在獨立分支 loc/PROJ-7-abcdef 上工作', '完成時先 commit', '做了什麼、根本原因、如何驗證、還有什麼風險']) {
      expect(rules).toContain(part);
    }
    expect(handoverBrief(q, dungeon)).toBe(brief);
    expect(handoverBrief({ ...q, scroll: '已被召回' }, dungeon)).toBe(`${brief}\n\n先前冒險的卷軸：\n已被召回`);
  });
});
