// Shared helpers for the Task 2 SDK spikes. Not product code.
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export const MODEL = 'claude-haiku-5-5';

/** process.env copy without API-key variables, so the CLI uses the claude.ai login. */
export function subscriptionEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

export function repoArg(): string {
  const p = process.argv[2];
  if (!p) {
    console.error('usage: npx tsx spikes/<name>.ts <throwaway git repo path>');
    process.exit(2);
  }
  return path.resolve(p);
}

export function log(label: string, value: unknown): void {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

/** One-line summary of a streamed SDK message (assistant text / tool_use / result). */
export function summarize(msg: SDKMessage): string | null {
  if (msg.type === 'assistant') {
    const parts = msg.message.content.map((b: any) => {
      if (b.type === 'text') return `text: ${b.text.slice(0, 300)}`;
      if (b.type === 'tool_use') return `tool_use ${b.name} ${JSON.stringify(b.input).slice(0, 300)}`;
      return b.type;
    });
    return `[assistant] ${parts.join(' | ')}`;
  }
  if (msg.type === 'user') {
    const content = (msg.message as any).content;
    if (Array.isArray(content)) {
      const parts = content
        .filter((b: any) => b.type === 'tool_result')
        .map((b: any) => {
          const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          return `tool_result${b.is_error ? ' (ERROR)' : ''}: ${text.slice(0, 300)}`;
        });
      if (parts.length) return `[user] ${parts.join(' | ')}`;
    }
    return null;
  }
  if (msg.type === 'result') {
    const r: any = msg;
    return `[result] subtype=${r.subtype} is_error=${r.is_error} turns=${r.num_turns} result=${String(r.result ?? '').slice(0, 300)} permission_denials=${JSON.stringify(r.permission_denials ?? [])}`;
  }
  if (msg.type === 'system' && msg.subtype !== 'init') {
    return `[system/${msg.subtype}] ${JSON.stringify(msg).slice(0, 300)}`;
  }
  return null;
}
