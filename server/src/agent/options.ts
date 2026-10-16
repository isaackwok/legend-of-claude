import type { CanUseTool, Options, SessionStore } from '@anthropic-ai/claude-agent-sdk';
import type { ClassId, Npc, Settings } from '@loc/shared';

/** Latest model per tier in this environment; the only place model IDs are spelled. */
export const MODELS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' } as const;

export const CLASS_TEMPLATES: Record<ClassId, Pick<Npc, 'model' | 'effort' | 'equipment'>> = {
  warrior: { model: MODELS.opus, effort: 'high', equipment: { connectorPrefixes: [], readOnly: false } },
  scholar: { model: MODELS.sonnet, effort: 'medium', equipment: { connectorPrefixes: [], readOnly: true } },
  scout: { model: MODELS.haiku, effort: 'low', equipment: { connectorPrefixes: [], readOnly: true } },
  freeman: { model: MODELS.sonnet, effort: 'medium', equipment: { connectorPrefixes: [], readOnly: false } },
};

export const READ_ONLY_DENY = ['Edit', 'Write', 'NotebookEdit'];

/** Pushing and opening PRs is done by the game at settlement, never by an NPC (spike: auto mode allows push). */
export const GIT_PUSH_DENY = ['Bash(git push *)', 'Bash(git push)'];

/** Connector prefixes found by the last inventory; `[]` before one exists (then no connector is denied). */
export function connectorPrefixesFrom(settings: Settings): string[] {
  return settings.connectors?.map((c) => c.prefix) ?? [];
}

/**
 * Deny rule hiding one connector's tools. Accepts a bare prefix (`slack` -> `mcp__slack__*`) or the
 * full tool prefix the inventory stores (`mcp__claude_ai_Slack__` -> `mcp__claude_ai_Slack__*`).
 */
export function connectorDenyRule(prefix: string): string {
  if (prefix.startsWith('mcp__')) return prefix.endsWith('__') ? `${prefix}*` : `${prefix}__*`;
  return `mcp__${prefix}__*`;
}

export interface BuildAgentOptionsInput {
  npc: Npc;
  cwd: string;
  appendPrompt?: string;
  allConnectorPrefixes: string[];
  sessionStore: SessionStore;
  env: Record<string, string | undefined>;
  resume?: string;
  canUseTool?: CanUseTool;
  outputFormat?: Options['outputFormat'];
  forceReadOnly?: boolean;
}

/** Agent SDK options for every NPC run. Never uses `bypassPermissions`. */
export function buildAgentOptions(input: BuildAgentOptionsInput): Options {
  const { npc, appendPrompt } = input;
  const readOnly = npc.equipment.readOnly || input.forceReadOnly === true;
  const equipped = new Set(npc.equipment.connectorPrefixes);
  const disallowedTools = [
    ...GIT_PUSH_DENY,
    ...(readOnly ? READ_ONLY_DENY : []),
    ...input.allConnectorPrefixes.filter((p) => !equipped.has(p)).map(connectorDenyRule),
  ];
  const options: Options = {
    systemPrompt: { type: 'preset', preset: 'claude_code', append: appendPrompt ? `${npc.persona}\n\n${appendPrompt}` : npc.persona },
    model: npc.model,
    effort: npc.effort,
    // Project and local settings only, never the user's own (spec §3).
    settingSources: ['project', 'local'],
    permissionMode: npc.cautious ? 'acceptEdits' : 'auto',
    cwd: input.cwd,
    sessionStore: input.sessionStore,
    env: input.env,
    includePartialMessages: false,
    disallowedTools,
    // M1 NPCs have no game skills: `skills` and `plugins` stay unset so every project skill remains
    // visible. Per-NPC filtering needs the naming rule (b) in docs/superpowers/spikes/2026-10-16-results.md.
  };
  if (input.resume !== undefined) options.resume = input.resume;
  if (input.canUseTool !== undefined) options.canUseTool = input.canUseTool;
  if (input.outputFormat !== undefined) options.outputFormat = input.outputFormat;
  return options;
}
