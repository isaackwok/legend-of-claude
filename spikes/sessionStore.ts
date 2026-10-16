// Spike 4: InMemorySessionStore + resume, and whether mcp__<prefix>__* deny rules remove a connector.
// Usage:
//   npx tsx spikes/sessionStore.ts <repo>          store + resume (moves the local transcript aside before resuming,
//                                                  so the resume can only succeed from the store)
//   npx tsx spikes/sessionStore.ts <repo> --deny   deny-rule forms vs. claude.ai connectors (no tool is called)
import { InMemorySessionStore, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODEL, log, repoArg, subscriptionEnv, summarize } from './_shared.ts';

const cwd = repoArg();
const base = {
  cwd,
  model: MODEL,
  settingSources: ['project', 'local'] as const,
  permissionMode: 'auto' as const,
  systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: 'Spike run. Be terse.' },
  env: subscriptionEnv(),
};

async function run(prompt: string, extra: Record<string, unknown>): Promise<{ sessionId?: string; result?: string }> {
  let sessionId: string | undefined;
  let result: string | undefined;
  for await (const msg of query({ prompt, options: { ...base, settingSources: [...base.settingSources], maxTurns: 1, ...extra } })) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      sessionId = msg.session_id;
      log('init.session_id', sessionId);
    } else {
      const s = summarize(msg);
      if (s) console.log(s);
    }
    if (msg.type === 'result') result = (msg as any).result;
  }
  return { sessionId, result };
}

/** Move ~/.claude/projects/<any>/<sessionId>.jsonl out of the way so resume must use the store. */
function moveLocalTranscriptAside(sessionId: string): string | null {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  const parking = path.join(os.tmpdir(), 'loc-spike-parked-transcripts');
  mkdirSync(parking, { recursive: true });
  for (const dir of readdirSync(projects)) {
    const f = path.join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(f)) {
      const dest = path.join(parking, `${sessionId}.jsonl`);
      renameSync(f, dest);
      return `${f} -> ${dest}`;
    }
  }
  return null;
}

async function storeAndResume() {
  const store = new InMemorySessionStore();
  const first = await run('請記住暗號 PINEAPPLE-42，只回覆 OK。', { sessionStore: store });
  log('store.size after first run', store.size);
  log('store.listSessions', await store.listSessions(storeProjectKey(store)));
  if (!first.sessionId) throw new Error('no session id');
  log('local transcript moved', moveLocalTranscriptAside(first.sessionId));

  const second = await run('我剛剛請你做什麼？用一句話回答，並說出暗號。', { sessionStore: store, resume: first.sessionId });
  log('resume result', second.result);
  log('resume session id same as first?', second.sessionId === first.sessionId);
  log('store.size after resume', store.size);
}

/** InMemorySessionStore has no public key list; pull projectKey out of its private map for logging only. */
function storeProjectKey(store: InMemorySessionStore): string {
  const keys = [...((store as any).store as Map<string, unknown>).keys()];
  log('store raw keys', keys);
  try {
    return JSON.parse(keys[0]).projectKey;
  } catch {
    return keys[0]?.split('/')[0] ?? '';
  }
}

async function denyRules() {
  // Three rule spellings, one per connector:
  //   disallowedTools 'mcp__claude_ai_Slack__*'          (wildcard, SDK option)
  //   disallowedTools 'mcp__claude_ai_Google_Calendar'   (server-level, no wildcard, SDK option)
  //   settings.permissions.deny 'mcp__claude_ai_Gmail__*' (wildcard, flag-settings deny rule)
  const disallowedTools = ['mcp__claude_ai_Slack__*', 'mcp__claude_ai_Google_Calendar'];
  const settings = { permissions: { deny: ['mcp__claude_ai_Gmail__*'] } };
  log('disallowedTools', disallowedTools);
  log('settings', settings);

  let release!: () => void;
  const go = new Promise<void>((r) => (release = r));
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  async function* input(): AsyncGenerator<SDKUserMessage> {
    await go;
    yield { type: 'user', message: { role: 'user', content: 'Reply with just: OK' }, parent_tool_use_id: null, session_id: '' } as SDKUserMessage;
    await done;
  }
  const q = query({ prompt: input(), options: { ...base, settingSources: [...base.settingSources], maxTurns: 1, disallowedTools, settings } });
  await q.initializationResult();
  await new Promise((r) => setTimeout(r, 8000));
  const status = await q.mcpServerStatus();
  const watch = ['claude.ai Slack', 'claude.ai Google Calendar', 'claude.ai Gmail', 'claude.ai Google Drive'];
  log(
    'mcpServerStatus (watched)',
    status.filter((s) => watch.includes(s.name)).map((s) => ({ name: s.name, status: s.status, toolCount: s.tools?.length ?? 0 })),
  );
  release();
  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      const tools: string[] = (msg as any).tools;
      const count = (p: string) => tools.filter((t) => t.startsWith(p)).length;
      log('init.tools counts per connector', {
        Slack: count('mcp__claude_ai_Slack__'),
        Google_Calendar: count('mcp__claude_ai_Google_Calendar__'),
        Gmail: count('mcp__claude_ai_Gmail__'),
        Google_Drive_control: count('mcp__claude_ai_Google_Drive__'),
      });
      log('init.mcp_servers (watched)', (msg as any).mcp_servers.filter((s: any) => watch.includes(s.name)));
    } else {
      const s = summarize(msg);
      if (s) console.log(s);
    }
    if (msg.type === 'result') finish();
  }
}

if (process.argv.includes('--deny')) await denyRules();
else await storeAndResume();
