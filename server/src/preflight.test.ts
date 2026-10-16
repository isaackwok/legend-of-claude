import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueryFn } from './agent/queryFn.js';
import { NOT_LOGGED_IN_WARNING, runPreflight, sdkEnv } from './preflight.js';

/** Minimal inline fake: a QueryFn whose stream yields `messages`, or throws `error`. */
function fakeQuery(messages: unknown[], error?: Error): { fn: QueryFn; calls: Array<{ options?: Record<string, unknown> }> } {
  const calls: Array<{ options?: Record<string, unknown> }> = [];
  const fn = ((params: { options?: Record<string, unknown> }) => {
    calls.push(params);
    async function* gen() {
      for (const m of messages) yield m;
      if (error) throw error;
    }
    return gen();
  }) as unknown as QueryFn;
  return { fn, calls };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'loc-pre-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('sdkEnv', () => {
  it('removes API-key variables and reports which were ignored', () => {
    const { env, ignored } = sdkEnv({ ANTHROPIC_API_KEY: 'x', PATH: '/bin' });
    expect(env).toEqual({ PATH: '/bin' });
    expect(ignored).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('removes both variables and does not mutate the input', () => {
    const input = { ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y', HOME: '/h' };
    const { env, ignored } = sdkEnv(input);
    expect(env).toEqual({ HOME: '/h' });
    expect(ignored).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
    expect(input.ANTHROPIC_API_KEY).toBe('x');
  });

  it('reports nothing when neither is set', () => {
    expect(sdkEnv({ PATH: '/bin' })).toEqual({ env: { PATH: '/bin' }, ignored: [] });
  });
});

describe('runPreflight', () => {
  const init = { type: 'system', subtype: 'init', apiKeySource: 'none' };
  const okResult = { type: 'result', subtype: 'success', is_error: false, result: 'OK' };

  it('reads apiKeySource and reports logged in; query is tiny, Haiku, sandboxed and key-free', async () => {
    const { fn, calls } = fakeQuery([init, okResult]);
    const result = await runPreflight(fn, { dataDir: dir, env: { ANTHROPIC_API_KEY: 'k', PATH: '/bin' } });
    expect(result).toEqual({ ignoredEnvVars: ['ANTHROPIC_API_KEY'], apiKeySource: 'none', loggedIn: true, warnings: [] });
    const options = calls[0]!.options!;
    expect(options).toMatchObject({ model: 'claude-haiku-5-5', maxTurns: 1, settingSources: [], cwd: join(dir, 'guildhall') });
    expect((options['env'] as Record<string, string>)['ANTHROPIC_API_KEY']).toBeUndefined();
    expect((await stat(join(dir, 'guildhall'))).isDirectory()).toBe(true);
  });

  it('reports not logged in when the query throws "Not logged in"', async () => {
    const { fn } = fakeQuery([], new Error('Not logged in · Please run /login'));
    const result = await runPreflight(fn, { dataDir: dir, env: {} });
    expect(result.loggedIn).toBe(false);
    expect(result.warnings).toEqual([NOT_LOGGED_IN_WARNING]);
    expect(NOT_LOGGED_IN_WARNING).toBe('請先在終端機執行 claude 並用 claude.ai 帳號登入');
  });

  it('reports not logged in on an auth_status error', async () => {
    const { fn } = fakeQuery([{ type: 'auth_status', isAuthenticating: false, output: [], error: 'Not logged in' }]);
    expect((await runPreflight(fn, { dataDir: dir, env: {} })).loggedIn).toBe(false);
  });

  it('reports not logged in on an error result that mentions it', async () => {
    const { fn } = fakeQuery([init, { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Not logged in'] }]);
    expect((await runPreflight(fn, { dataDir: dir, env: {} })).loggedIn).toBe(false);
  });

  it('does not claim logged-out for an unrelated failure, but warns', async () => {
    const { fn } = fakeQuery([], new Error('ECONNRESET'));
    const result = await runPreflight(fn, { dataDir: dir, env: {} });
    expect(result.loggedIn).toBe(true);
    expect(result.warnings).toEqual(['啟動檢查失敗：ECONNRESET']);
  });
});
