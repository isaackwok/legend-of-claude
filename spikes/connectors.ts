// Spike 1: do claude.ai connectors appear with settingSources ['project','local']?
// Usage: npx tsx spikes/connectors.ts <repo> [--sources=project,local] [--no-prompt]
import { query, type SDKUserMessage, type SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { MODEL, log, repoArg, subscriptionEnv, summarize } from './_shared.ts';

const cwd = repoArg();
const sourcesArg = process.argv.find((a) => a.startsWith('--sources='));
const settingSources = (sourcesArg ? sourcesArg.split('=')[1].split(',').filter(Boolean) : ['project', 'local']) as SettingSource[];
const noPrompt = process.argv.includes('--no-prompt');

let release!: () => void;
const go = new Promise<void>((r) => (release = r));
let finish!: () => void;
const done = new Promise<void>((r) => (finish = r));

async function* input(): AsyncGenerator<SDKUserMessage> {
  await go;
  if (!noPrompt) {
    yield {
      type: 'user',
      message: { role: 'user', content: 'Reply with just: OK' },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage;
    await done;
  }
}

const q = query({
  prompt: input(),
  options: {
    cwd,
    model: MODEL,
    maxTurns: 1,
    settingSources,
    permissionMode: 'auto',
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Spike run. Answer in one word.' },
    env: subscriptionEnv(),
  },
});

log('settingSources', settingSources);
const initRes: any = await q.initializationResult();
log('initializationResult keys', Object.keys(initRes));
log('initializationResult.account', initRes.account ?? null);

const fmt = (list: any[]) =>
  list.map((s) => ({ name: s.name, status: s.status, scope: s.scope, source: s.source, tools: (s.tools ?? []).map((t: any) => t.name).slice(0, 5), toolCount: (s.tools ?? []).length, error: s.error }));

log('mcpServerStatus (immediately)', fmt(await q.mcpServerStatus()));
await new Promise((r) => setTimeout(r, 8000));
log('mcpServerStatus (after 8s)', fmt(await q.mcpServerStatus()));

release();
if (noPrompt) {
  q.close();
} else {
  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      const init: any = msg;
      log('init.apiKeySource', init.apiKeySource);
      log('init.model / permissionMode', { model: init.model, permissionMode: init.permissionMode, claude_code_version: init.claude_code_version });
      log('init.mcp_servers', init.mcp_servers);
      log('init.tools (mcp__*)', init.tools.filter((t: string) => t.startsWith('mcp__')));
      log('init.tools (non-mcp)', init.tools.filter((t: string) => !t.startsWith('mcp__')));
    } else {
      const s = summarize(msg);
      if (s) console.log(s);
    }
    if (msg.type === 'result') finish();
  }
}
