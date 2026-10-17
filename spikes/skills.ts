// Spike 2: plugin skill naming, and whether the `skills` filter also hides project skills.
// Usage: npx tsx spikes/skills.ts <repo> <pluginDir> [--skills='["spikeplug:a"]' | --skills=all | --skills=omit] [--invoke=<skill>]
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { MODEL, log, repoArg, subscriptionEnv, summarize } from './_shared.ts';

const cwd = repoArg();
const pluginDir = path.resolve(process.argv[3] ?? '');
const skillsArg = process.argv.find((a) => a.startsWith('--skills='))?.slice('--skills='.length) ?? '["spikeplug:a"]';
const skills: string[] | 'all' | undefined = skillsArg === 'omit' ? undefined : skillsArg === 'all' ? 'all' : JSON.parse(skillsArg);
// --invoke=<name>: instead of listing, ask the model to call the Skill tool with that name (checks the filter rejects it).
const invoke = process.argv.find((a) => a.startsWith('--invoke='))?.slice('--invoke='.length);
const prompt = invoke
  ? `Call the Skill tool exactly once with skill "${invoke}" and then report the tool result verbatim in one line.`
  : 'List the exact names of every skill you can invoke with the Skill tool, comma-separated, nothing else. Do not call any tool.';

log('skills option', skills ?? '(omitted)');
log('plugin dir', pluginDir);

const q = query({
  prompt,
  options: {
    cwd,
    model: MODEL,
    maxTurns: invoke ? 2 : 1,
    settingSources: ['project', 'local'],
    permissionMode: 'auto',
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Spike run. Be terse.' },
    plugins: [{ type: 'local', path: pluginDir }],
    ...(skills !== undefined ? { skills } : {}),
    env: subscriptionEnv(),
  },
});

for await (const msg of q) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    const init: any = msg;
    log('init.skills', init.skills);
    log('init.plugins', init.plugins);
    log('init.plugin_errors', init.plugin_errors ?? null);
    log('init.slash_commands', init.slash_commands);
    log('init.tools includes Skill', init.tools.includes('Skill'));
    log('init.mcp_servers status counts', init.mcp_servers.reduce((acc: Record<string, number>, s: any) => ((acc[s.status] = (acc[s.status] ?? 0) + 1), acc), {}));
  } else {
    const s = summarize(msg);
    if (s) console.log(s);
  }
}
