import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Preflight } from '@loc/shared';
import type { QueryFn } from './agent/queryFn.js';

const STRIPPED_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

export const NOT_LOGGED_IN_WARNING = '請先在終端機執行 claude 並用 claude.ai 帳號登入';

/** Env for SDK child processes: a copy of `env` without API-key variables, so the claude.ai login is used. */
export function sdkEnv(env: NodeJS.ProcessEnv = process.env): { env: Record<string, string | undefined>; ignored: string[] } {
  const out: Record<string, string | undefined> = { ...env };
  const ignored: string[] = [];
  for (const name of STRIPPED_ENV_VARS) {
    if (name in out) {
      if (out[name]) ignored.push(name);
      delete out[name];
    }
  }
  return { env: out, ignored };
}

const NOT_LOGGED_IN = /not logged in|please run \/login|authentication_failed|invalid api key/i;

function looksNotLoggedIn(text: unknown): boolean {
  return typeof text === 'string' && NOT_LOGGED_IN.test(text);
}

/**
 * Tiny Haiku query (maxTurns 1) in an empty folder. Reads `apiKeySource` from the init message and
 * looks for a not-logged-in signal. The stream is read to its result because login failure only
 * surfaces on the first API call, after init. Never throws.
 */
export async function runPreflight(
  queryFn: QueryFn,
  opts: { dataDir: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<Preflight> {
  const { env, ignored } = sdkEnv(opts.env);
  const result: Preflight = { ignoredEnvVars: ignored, loggedIn: true, warnings: [] };
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), opts.timeoutMs ?? 60_000);
  let q: ReturnType<QueryFn> | undefined;
  try {
    const cwd = join(opts.dataDir, 'guildhall');
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    q = queryFn({
      prompt: 'Reply with just: OK',
      options: { model: 'claude-haiku-5-5', maxTurns: 1, env, settingSources: [], cwd, abortController },
    });
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        result.apiKeySource = msg.apiKeySource;
      } else if (msg.type === 'auth_status') {
        if (msg.error || looksNotLoggedIn(msg.output.join('\n'))) result.loggedIn = false;
      } else if (msg.type === 'assistant') {
        if (msg.error === 'authentication_failed') result.loggedIn = false;
      } else if (msg.type === 'result') {
        if (msg.is_error) {
          const text = 'errors' in msg ? msg.errors.join('\n') : msg.result;
          if (looksNotLoggedIn(text)) result.loggedIn = false;
        }
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (looksNotLoggedIn(message)) result.loggedIn = false;
    else result.warnings.push(abortController.signal.aborted ? '啟動檢查逾時' : `啟動檢查失敗：${message}`);
  } finally {
    clearTimeout(timer);
    try {
      q?.close?.();
    } catch {
      /* already closed */
    }
  }
  if (!result.loggedIn) result.warnings.push(NOT_LOGGED_IN_WARNING);
  return result;
}
