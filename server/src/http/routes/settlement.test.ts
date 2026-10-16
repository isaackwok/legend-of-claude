import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Preflight, Quest } from '@loc/shared';
import { fakeQuery, type FakeQuery, type FakeStep } from '../../../test/fakeQuery.js';
import { ApprovalBroker } from '../../agent/approvals.js';
import type { QueryFn } from '../../agent/queryFn.js';
import { ClerkService } from '../../clerk/clerk.js';
import { loadConfig, type Config } from '../../config.js';
import { seedNpcs } from '../../npcs/seeds.js';
import { QuestService } from '../../quests/service.js';
import { buildSnapshot } from '../../snapshot.js';
import { FileSessionStore } from '../../store/fileSessionStore.js';
import { repos as makeRepos, type Repos } from '../../store/jsonRepo.js';
import { createApp } from '../app.js';

const preflight: Preflight = { ignoredEnvVars: [], loggedIn: true, warnings: [] };

let tmp: string;
let dataDir: string;
let config: Config;
let repos: Repos;
let quests: QuestService;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'loc-clerk-routes-')));
  dataDir = join(tmp, 'data');
  config = loadConfig({ LOC_DATA_DIR: dataDir });
  repos = makeRepos(dataDir);
  for (const npc of seedNpcs()) await repos.npcs.put(npc);
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

function appWith(queryFn: QueryFn) {
  const broker = new ApprovalBroker();
  const hub = { broadcast: () => undefined };
  const sessionStore = new FileSessionStore(join(dataDir, 'sessions'));
  quests = new QuestService({ repos, hub, broker, queryFn: fakeQuery([]).fn, dataDir, sessionStore, env: {} });
  const clerk = new ClerkService({ repos, hub, broker, queryFn, dataDir, sessionStore, quests, env: {}, inventoryPollMs: 1, inventoryTimeoutMs: 500 });
  const app = createApp({ config, repos, hub, getSnapshot: () => buildSnapshot(repos, preflight, broker.list()), getPreflight: () => preflight, quests, broker, clerk });
  return (path: string, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Host: '127.0.0.1:4517', Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

const structured = (output: unknown): FakeStep[] => [
  { type: 'system', subtype: 'init', session_id: 'clerk-s', permissionMode: 'auto' },
  { waitForInput: 1 },
  { type: 'result', subtype: 'success', is_error: false, result: '', structured_output: output, session_id: 'clerk-s', total_cost_usd: 0 },
];
const failing: FakeStep[] = [
  { type: 'system', subtype: 'init', session_id: 'clerk-s', permissionMode: 'auto' },
  { waitForInput: 1 },
  { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['connector down'], session_id: 'clerk-s', total_cost_usd: 0 },
];
const issue = { found: true, key: 'ABC-1', title: '修好登入', description: '描述', storyPoints: null, priority: 'High', url: 'https://acme.atlassian.net/browse/ABC-1', error: null };

describe('POST /api/jira/import', () => {
  it('201 with the new jira quest', async () => {
    const req = appWith(fakeQuery(structured(issue)).fn);
    const res = await req('/api/jira/import', { key: 'ABC-1' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ title: '修好登入', stars: 3, source: { kind: 'jira', key: 'ABC-1' } });
  });

  it('400 for a missing or unknown key, 502 when the clerk fails', async () => {
    let req = appWith(fakeQuery(structured({ ...issue, found: false, error: '查無 ABC-9' })).fn);
    expect((await req('/api/jira/import', {})).status).toBe(400);
    const unknown = await req('/api/jira/import', { key: 'ABC-9' });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: '查無 ABC-9' });

    req = appWith(fakeQuery(failing).fn);
    const failed = await req('/api/jira/import', { key: 'ABC-9' });
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: string }).error).toContain('connector down');
    expect(await repos.quests.list()).toEqual([]);
  });
});

describe('inventory routes', () => {
  it('GET returns the stored inventory, POST /refresh takes it again', async () => {
    const slack = { name: 'claude.ai Slack', status: 'connected' as const, source: 'claudeai' };
    const fake: FakeQuery = fakeQuery([], { mcpServerStatus: [[slack]] });
    const req = appWith(fake.fn);
    expect(await (await req('/api/inventory')).json()).toEqual([]);
    const refreshed = await req('/api/inventory/refresh', {});
    expect(refreshed.status).toBe(200);
    const expected = [{ name: 'claude.ai Slack', prefix: 'claude_ai_Slack', status: 'connected' }];
    expect(await refreshed.json()).toEqual(expected);
    expect(await (await req('/api/inventory')).json()).toEqual(expected);
  });

  it('502 when the inventory fails', async () => {
    const req = appWith(fakeQuery([], { mcpServerStatus: [new Error('boom')] }).fn);
    expect((await req('/api/inventory/refresh', {})).status).toBe(502);
  });
});

describe('settlement routes', () => {
  async function jiraQuest(status: Quest['status']): Promise<Quest> {
    const q = await quests.create({ title: 'j', body: '', source: { kind: 'jira', key: 'ABC-1', url: 'https://acme.atlassian.net/browse/ABC-1' } });
    const next = { ...q, status };
    await repos.quests.put(next);
    return next;
  }

  it('GET settlement-options returns transitions, lastChoices and 502 on failure', async () => {
    const transitions = [{ id: '31', name: 'Done' }];
    let req = appWith(fakeQuery(structured({ ok: true, transitions, error: null })).fn);
    const q = await jiraQuest('review');
    const res = await req(`/api/quests/${q.id}/settlement-options`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isJira: true, transitions, lastChoices: null });
    expect((await req('/api/quests/nope/settlement-options')).status).toBe(404);

    req = appWith(fakeQuery(failing).fn);
    expect((await req(`/api/quests/${q.id}/settlement-options`)).status).toBe(502);
  });

  it('POST settle validates the body, refuses non-review quests and settles a review quest', async () => {
    const fake = fakeQuery(structured({ ok: true, error: null }));
    const req = appWith(fake.fn);
    const open = await jiraQuest('open');
    expect((await req(`/api/quests/${open.id}/settle`, { pushAndPr: 'yes' })).status).toBe(400);
    const refused = await req(`/api/quests/${open.id}/settle`, { pushAndPr: false, linkPr: false, openTicket: false });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: '委託目前是「待接委託」，不能結算' });
    expect((await req('/api/quests/nope/settle', { pushAndPr: false, linkPr: false, openTicket: false })).status).toBe(404);

    const review = await jiraQuest('review');
    const res = await req(`/api/quests/${review.id}/settle`, { pushAndPr: false, jiraComment: '完成', linkPr: false, openTicket: true });
    expect(res.status).toBe(200);
    const record = (await res.json()) as { results: unknown[]; choices: unknown };
    expect(record.results).toEqual([{ action: 'jiraComment', ok: true, message: '已在 ABC-1 留言' }]);
    expect(record.choices).toEqual({ pushAndPr: false, jiraComment: '完成', linkPr: false, openTicket: true });
    expect((await repos.quests.get(review.id))!.status).toBe('done');
  });
});
