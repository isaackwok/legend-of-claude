import { InMemorySessionStore } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { ClassId, Npc, Settings } from '@loc/shared';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repos as makeRepos, type Repos } from '../store/jsonRepo.js';
import { ensureSeedNpcs, seedNpcs } from '../npcs/seeds.js';
import { CLASS_TEMPLATES, GIT_PUSH_DENY, MODELS, READ_ONLY_DENY, buildAgentOptions, connectorPrefixesFrom } from './options.js';

const sessionStore = new InMemorySessionStore();

function npc(over: Partial<Npc> = {}): Npc {
  return {
    id: 'n1', name: '測試員', classId: 'warrior', persona: '你是測試用的戰士。',
    ...CLASS_TEMPLATES.warrior, skills: [], ...over,
  };
}

function build(over: Partial<Parameters<typeof buildAgentOptions>[0]> = {}) {
  return buildAgentOptions({
    npc: npc(), cwd: '/tmp/dungeon', allConnectorPrefixes: [], sessionStore, env: { PATH: '/bin' }, ...over,
  });
}

describe('CLASS_TEMPLATES', () => {
  it('maps classes to models, effort and write access', () => {
    expect(CLASS_TEMPLATES.warrior).toMatchObject({ model: MODELS.opus, effort: 'high', equipment: { readOnly: false } });
    expect(CLASS_TEMPLATES.scholar).toMatchObject({ model: MODELS.sonnet, effort: 'medium', equipment: { readOnly: true } });
    expect(CLASS_TEMPLATES.scout).toMatchObject({ model: MODELS.haiku, effort: 'low', equipment: { readOnly: true } });
    expect(CLASS_TEMPLATES.freeman).toMatchObject({ model: MODELS.sonnet, effort: 'medium', equipment: { readOnly: false } });
  });
});

describe('connectorPrefixesFrom', () => {
  it('returns [] before inventory and the prefixes afterwards', () => {
    const base: Settings = { id: 'settings', scanRoot: '/x' };
    expect(connectorPrefixesFrom(base)).toEqual([]);
    expect(connectorPrefixesFrom({ ...base, connectors: [{ name: 'a', prefix: 'jira', status: 'connected' }, { name: 'b', prefix: 'slack', status: 'connected' }] })).toEqual(['jira', 'slack']);
  });
});

describe('buildAgentOptions', () => {
  it('denies write tools for read-only classes', () => {
    const o = build({ npc: npc({ classId: 'scholar', ...CLASS_TEMPLATES.scholar }) });
    for (const t of READ_ONLY_DENY) expect(o.disallowedTools).toContain(t);
  });

  it('does not deny write tools for a writable class', () => {
    const o = build();
    for (const t of READ_ONLY_DENY) expect(o.disallowedTools).not.toContain(t);
  });

  it('forceReadOnly adds the write denies to a writable npc', () => {
    const o = build({ forceReadOnly: true });
    for (const t of READ_ONLY_DENY) expect(o.disallowedTools).toContain(t);
  });

  it('always denies git push for every npc', () => {
    for (const classId of Object.keys(CLASS_TEMPLATES) as ClassId[]) {
      const o = build({ npc: npc({ classId, ...CLASS_TEMPLATES[classId] }) });
      expect(o.disallowedTools).toEqual(expect.arrayContaining([...GIT_PUSH_DENY]));
    }
    expect(GIT_PUSH_DENY).toEqual(['Bash(git push *)', 'Bash(git push)']);
  });

  it('denies connectors the npc is not equipped with', () => {
    const equipped = npc({ equipment: { readOnly: false, connectorPrefixes: ['jira'] } });
    const o = build({ npc: equipped, allConnectorPrefixes: ['jira', 'github', 'slack'] });
    expect(o.disallowedTools).toContain('mcp__github__*');
    expect(o.disallowedTools).toContain('mcp__slack__*');
    expect(o.disallowedTools).not.toContain('mcp__jira__*');
  });

  it('accepts full claude.ai style prefixes without double wrapping', () => {
    const o = build({ allConnectorPrefixes: ['mcp__claude_ai_Slack__'] });
    expect(o.disallowedTools).toContain('mcp__claude_ai_Slack__*');
  });

  it('adds no connector rules when no inventory exists', () => {
    const o = build();
    expect(o.disallowedTools?.some((t) => t.startsWith('mcp__'))).toBe(false);
  });

  it('uses auto mode, or acceptEdits when cautious', () => {
    expect(build().permissionMode).toBe('auto');
    expect(build({ npc: npc({ cautious: true }) }).permissionMode).toBe('acceptEdits');
  });

  it('never produces bypassPermissions', () => {
    for (const classId of Object.keys(CLASS_TEMPLATES) as ClassId[]) {
      for (const cautious of [true, false, undefined]) {
        for (const forceReadOnly of [true, false, undefined]) {
          const o = build({ npc: npc({ classId, ...CLASS_TEMPLATES[classId], cautious }), forceReadOnly });
          expect(o.permissionMode).not.toBe('bypassPermissions');
          expect(o.allowDangerouslySkipPermissions).toBeUndefined();
        }
      }
    }
  });

  it('settingSources is always project and local; no skills or plugins in M1', () => {
    expect(build().settingSources).toEqual(['project', 'local']);
    expect('skills' in build()).toBe(false);
    expect('plugins' in build()).toBe(false);
  });

  it('system prompt is the claude_code preset with persona then appendPrompt', () => {
    const o = build({ appendPrompt: '請先讀 README。' });
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: '你是測試用的戰士。\n\n請先讀 README。' });
    expect(build().systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: '你是測試用的戰士。' });
  });

  it('passes through model, effort, cwd, store, env and basic flags', () => {
    const env = { PATH: '/bin', FOO: undefined };
    const o = build({ env });
    expect(o).toMatchObject({ model: MODELS.opus, effort: 'high', cwd: '/tmp/dungeon', sessionStore, env, includePartialMessages: false });
  });

  it('passes through resume, canUseTool and outputFormat only when provided', () => {
    const plain = build();
    for (const k of ['resume', 'canUseTool', 'outputFormat']) expect(k in plain).toBe(false);
    const canUseTool: CanUseTool = async () => ({ behavior: 'allow' });
    const outputFormat = { type: 'json_schema' as const, schema: { type: 'object' } };
    const o = build({ resume: 'sess-1', canUseTool, outputFormat });
    expect(o.resume).toBe('sess-1');
    expect(o.canUseTool).toBe(canUseTool);
    expect(o.outputFormat).toEqual(outputFormat);
  });
});

describe('seedNpcs', () => {
  it('has exactly one clerk, with no cautious flags (auto works on all 5.5 models)', () => {
    const seeds = seedNpcs();
    expect(seeds.filter((n) => n.builtin === 'clerk')).toHaveLength(1);
    expect(seeds.map((n) => n.id)).toEqual(['clerk', 'alex', 'lina', 'toby']);
    expect(seeds.some((n) => n.cautious)).toBe(false);
    const clerk = seeds.find((n) => n.builtin === 'clerk')!;
    expect(clerk).toMatchObject({ model: MODELS.haiku, effort: 'low', equipment: { readOnly: true } });
    expect(clerk.persona).toContain('Jira');
    expect(clerk.persona).toContain('GitHub');
    expect(seeds.find((n) => n.id === 'alex')).toMatchObject({ classId: 'warrior', name: '阿列克' });
    expect(seeds.find((n) => n.id === 'lina')).toMatchObject({ classId: 'scholar', name: '莉娜' });
    expect(seeds.find((n) => n.id === 'toby')).toMatchObject({ classId: 'scout', name: '托比' });
  });

  it('has unique ids and persona text without emoji', () => {
    const seeds = seedNpcs();
    expect(new Set(seeds.map((n) => n.id)).size).toBe(seeds.length);
    for (const n of seeds) expect(n.persona).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('ensureSeedNpcs', () => {
  let dir: string;
  let repos: Repos;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loc-seeds-'));
    repos = makeRepos(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('writes the seeds into an empty collection', async () => {
    await ensureSeedNpcs(repos);
    expect((await repos.npcs.list()).map((n) => n.id)).toEqual(['clerk', 'alex', 'lina', 'toby']);
  });

  it('leaves a non-empty collection untouched', async () => {
    await repos.npcs.put(npc({ id: 'custom' }));
    await ensureSeedNpcs(repos);
    expect((await repos.npcs.list()).map((n) => n.id)).toEqual(['custom']);
  });

  it('does not duplicate on a second call', async () => {
    await ensureSeedNpcs(repos);
    await ensureSeedNpcs(repos);
    expect(await repos.npcs.list()).toHaveLength(4);
  });
});
